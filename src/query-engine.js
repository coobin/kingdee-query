const { KingdeeError } = require("./kingdee");

function escapeValue(value) {
  return String(value).replaceAll("'", "''").replace(/[\u0000-\u001f]/g, "");
}

function isoDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`日期格式应为 YYYY-MM-DD：${text}`);
  return text;
}

function buildFilter(item, args, identity, config) {
  const clauses = [];
  const accepted = {};
  for (const [key, raw] of Object.entries(args || {})) {
    if (raw == null || raw === "" || key === "limit") continue;
    const field = item.filterFields[key];
    if (!field) continue;
    const value = escapeValue(raw);
    if (key === "dateFrom") clauses.push(`${field}>='${isoDate(value)}'`);
    else if (key === "dateTo") clauses.push(`${field}<'${nextDay(isoDate(value))}'`);
    else if (key.endsWith("Name")) clauses.push(`${field} LIKE '%${value}%'`);
    else clauses.push(`${field}='${value}'`);
    accepted[key] = raw;
  }

  if (item.forceSelfScope && !config.scopeAdmins.has(identity.kingdeeUsername)) {
    const source = item.selfValueSource || "kingdeeUsername";
    const ownValue = escapeValue(identity[source] || identity.kingdeeUsername);
    clauses.push(`${item.selfField}='${ownValue}'`);
    accepted.scope = "self";
  }
  if (!clauses.length && item.requiresFilter) {
    throw Object.assign(new Error("查询范围过大，请至少提供一个筛选条件。"), { statusCode: 400 });
  }
  return { filter: clauses.join(" AND "), accepted };
}

function nextDay(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function normalizeLimit(value, maxRows) {
  const parsed = Number(value || 50);
  if (!Number.isInteger(parsed) || parsed < 1) return 50;
  return Math.min(parsed, maxRows);
}

function normalizeMinimumDays(value) {
  const parsed = Number(value == null || value === "" ? 180 : value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
    throw Object.assign(new Error("账龄天数应为 1 到 3650 之间的整数。"), { statusCode: 400 });
  }
  return parsed;
}

function businessDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(value, days) {
  const date = new Date(`${isoDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function elapsedDays(from, to) {
  const start = new Date(`${String(from).slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${isoDate(to)}T00:00:00Z`);
  return Math.floor((end - start) / 86400000);
}

function buildOverdueReceivableFilter(args, asOfDate) {
  const minimumDays = normalizeMinimumDays(args.minimumDays);
  const cutoffDate = shiftDate(asOfDate, -minimumDays);
  const clauses = [
    "FDocumentStatus='C'",
    "FCancelStatus='A'",
    "FIVALLAMOUNTFOR>0",
    "FNORECEIVEAMOUNT>0",
  ];
  const accepted = { asOfDate, minimumDays, cutoffDate };
  if (args.customerName) {
    const value = escapeValue(args.customerName);
    clauses.push(`FCustomerID.FName LIKE '%${value}%'`);
    accepted.customerName = args.customerName;
  }
  const subprojectNumber = args.subprojectNumber || args.projectNumber;
  if (subprojectNumber) {
    const value = escapeValue(subprojectNumber);
    clauses.push(`F_PARA_SaleSubProId.FNumber LIKE '%${value}%'`);
    accepted.subprojectNumber = subprojectNumber;
  }
  return { filter: clauses.join(" AND "), accepted };
}

function buildOverdueInvoiceFilter(cutoffDate, subprojectNumbers) {
  const quoted = subprojectNumbers.map((value) => `'${escapeValue(value)}'`).join(",");
  return [
    "FDocumentStatus='C'",
    "FCancelStatus='A'",
    `FINVOICEDATE<'${isoDate(cutoffDate)}'`,
    `F_PARA_SaleSubProId.FNumber IN (${quoted})`,
  ].join(" AND ");
}

function rowsToObjects(rows, fields, valueMappings = {}) {
  const labels = fields.map(([, label]) => label);
  return rows.map((row) => Object.fromEntries(labels.map((label, index) => {
    const value = row[index];
    const mapping = valueMappings[label];
    if (!mapping || value == null || value === "") return [label, value];
    return [label, mapping[String(value)] || "其他状态"];
  })));
}

class QueryEngine {
  constructor({ catalog, kingdee, config, now = () => new Date() }) {
    this.catalog = catalog;
    this.kingdee = kingdee;
    this.config = config;
    this.now = now;
  }

  async execute(identity, plan) {
    if (plan.tool === "workflow_progress") return this.workflow(identity, plan.arguments || {});
    const item = this.catalog[plan.tool];
    if (!item) throw Object.assign(new Error(`不支持的查询工具：${plan.tool}`), { statusCode: 400 });
    const args = plan.arguments || {};
    if (item.queryType === "overdue_receivables") return this.overdueReceivables(identity, item, args);
    const { filter, accepted } = buildFilter(item, args, identity, this.config);
    const limit = normalizeLimit(args.limit, this.config.kingdee.maxRows);
    const request = {
      FormId: item.formId,
      FieldKeys: item.fields.map(([key]) => key).join(","),
      FilterString: filter,
      OrderString: item.defaultOrder || "",
      StartRow: 0,
      Limit: limit,
      TopRowCount: 0,
    };
    const aggregation = resolveAggregation(item, args.aggregation);
    const rows = aggregation
      ? await this.queryForAggregation(identity, request)
      : await this.kingdee.executeBillQuery(identity.kingdeeUsername, request);
    const objects = rowsToObjects(rows, item.fields, item.valueMappings);
    const aggregate = aggregation ? calculateAggregate(objects, aggregation, rows.length >= this.config.kingdee.aggregationMaxRows) : null;
    const visibleObjects = aggregation ? objects.slice(0, limit) : objects;
    return {
      tool: plan.tool,
      label: item.label,
      query: accepted,
      columns: item.fields.map(([, label]) => label),
      rows: visibleObjects,
      count: rows.length,
      truncated: aggregation ? aggregate.partial : rows.length >= limit,
      aggregate,
      summary: aggregate ? summarizeAggregate(item.label, aggregate) : summarize(item.label, objects, rows.length >= limit),
    };
  }

  async overdueReceivables(identity, item, args) {
    const asOfDate = businessDate(this.now());
    const { filter, accepted } = buildOverdueReceivableFilter(args, asOfDate);
    const limit = normalizeLimit(args.limit, this.config.kingdee.maxRows);
    const maximum = this.config.kingdee.aggregationMaxRows;
    const requestLimit = Math.min(maximum + 1, 10000);
    let rawRows = await this.kingdee.executeBillQuery(identity.kingdeeUsername, {
      FormId: item.formId,
      FieldKeys: item.fields.map(([key]) => key).join(","),
      FilterString: filter,
      OrderString: item.defaultOrder || "FDate ASC,FBillNo ASC",
      StartRow: 0,
      Limit: requestLimit,
      TopRowCount: 0,
    });
    const receivablePartial = rawRows.length >= requestLimit;
    rawRows = rawRows.slice(0, maximum);
    const receivableRows = rowsToObjects(rawRows, item.fields);
    const candidateSubprojects = [...new Set(receivableRows.map((row) => String(row["销售子项目编码"] || "").trim()).filter(Boolean))];
    const invoiceSource = item.invoiceDateSource;
    if (!invoiceSource) throw new Error("超期未回款查询缺少开票日期来源配置。");
    const invoiceRows = [];
    let invoicePartial = false;
    for (const batch of chunkValues(candidateSubprojects, 150)) {
      const remaining = maximum + 1 - invoiceRows.length;
      if (remaining <= 0) { invoicePartial = true; break; }
      const page = await this.kingdee.executeBillQuery(identity.kingdeeUsername, {
        FormId: invoiceSource.formId,
        FieldKeys: invoiceSource.fields.map(([key]) => key).join(","),
        FilterString: buildOverdueInvoiceFilter(accepted.cutoffDate, batch),
        OrderString: invoiceSource.defaultOrder || "FINVOICEDATE ASC,FBillNo ASC",
        StartRow: 0,
        Limit: Math.min(remaining, 10000),
        TopRowCount: 0,
      });
      invoiceRows.push(...page);
      if (invoiceRows.length > maximum) { invoicePartial = true; break; }
    }
    const partial = receivablePartial || invoicePartial;
    const result = aggregateOverdueReceivables(receivableRows, {
      invoiceRows: rowsToObjects(invoiceRows.slice(0, maximum), invoiceSource.fields),
      asOfDate,
      minimumDays: accepted.minimumDays,
      partial,
    });
    return {
      tool: "overdue_receivables",
      label: item.label,
      query: accepted,
      columns: item.publicColumns,
      rows: result.rows.slice(0, limit),
      count: result.rows.length,
      truncated: partial || result.rows.length > limit,
      statistics: result.statistics,
      summary: result.summary,
    };
  }

  async queryForAggregation(identity, request) {
    const pageSize = Math.min(this.config.kingdee.maxRows, 200);
    const maximum = this.config.kingdee.aggregationMaxRows;
    const rows = [];
    while (rows.length < maximum) {
      const page = await this.kingdee.executeBillQuery(identity.kingdeeUsername, {
        ...request,
        StartRow: rows.length,
        Limit: Math.min(pageSize, maximum - rows.length),
      });
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  }

  async workflow(identity, args) {
    const billNumber = String(args.billNumber || "").trim();
    const formId = String(args.formId || "").trim();
    if (!billNumber || !formId) {
      throw Object.assign(new Error("查询审批进度需要 formId 和 billNumber。"), { statusCode: 400 });
    }
    const payload = await this.kingdee.workflowProgress(
      identity.kingdeeUsername,
      this.config.kingdee.workflowMethod,
      { FormId: formId, Number: billNumber },
    );
    return {
      tool: "workflow_progress",
      label: "审批进度",
      query: { formId, billNumber },
      workflow: payload,
      count: 1,
      summary: `已取得单据 ${billNumber} 的审批进度。`,
    };
  }
}

function aggregateOverdueReceivables(sourceRows, { invoiceRows = [], asOfDate, minimumDays, partial = false }) {
  const invoiceDates = new Map();
  for (const row of invoiceRows) {
    const code = String(row["销售子项目编码"] || "").trim();
    const date = String(row["开票日期"] || "").slice(0, 10);
    if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const key = normalizeSubprojectKey(code);
    let invoice = invoiceDates.get(key);
    if (!invoice) {
      invoice = { code, names: new Set(), firstDate: date, invoiceNumbers: new Set() };
      invoiceDates.set(key, invoice);
    }
    addIfPresent(invoice.names, row["销售子项目名称"]);
    addIfPresent(invoice.invoiceNumbers, row["销售发票号"]);
    if (date < invoice.firstDate) invoice.firstDate = date;
  }

  const subprojects = new Map();
  let rowsWithoutSubproject = 0;
  for (const row of sourceRows) {
    const code = String(row["销售子项目编码"] || "").trim();
    if (!code) { rowsWithoutSubproject += 1; continue; }
    const key = normalizeSubprojectKey(code);
    let subproject = subprojects.get(key);
    if (!subproject) {
      subproject = {
        code,
        names: new Set(),
        customers: new Set(),
        billNumbers: new Set(),
        organizations: new Set(),
        departments: new Set(),
        salespersons: new Set(),
        invoiceAmount: 0,
        outstandingAmount: 0,
      };
      subprojects.set(key, subproject);
    }
    addIfPresent(subproject.names, row["销售子项目名称"]);
    addIfPresent(subproject.customers, row["客户"]);
    addIfPresent(subproject.billNumbers, row["应收单号"]);
    addIfPresent(subproject.organizations, row["结算组织"]);
    addIfPresent(subproject.departments, row["销售部门"]);
    addIfPresent(subproject.salespersons, row["销售员"]);
    const invoiceAmount = Math.max(0, Number(row["已开票金额"]) || 0);
    const receivedAmount = Math.max(0, Number(row["已收金额"]) || 0);
    const entryOutstanding = Math.max(0, Number(row["未收金额"]) || 0);
    subproject.invoiceAmount += invoiceAmount;
    // Allocate collected money to the invoiced portion first, then cap by the entry's
    // current open balance. This keeps unbilled receivables out of the risk amount.
    subproject.outstandingAmount += Math.min(entryOutstanding, Math.max(0, invoiceAmount - receivedAmount));
  }

  let missingInvoiceDateSubprojects = 0;
  const rows = [...subprojects.entries()].filter(([, subproject]) => subproject.outstandingAmount > 0.004).map(([key, subproject]) => {
    const invoice = invoiceDates.get(key);
    if (!invoice) { missingInvoiceDateSubprojects += 1; return null; }
    invoice.names.forEach((name) => subproject.names.add(name));
    const invoiceAmount = roundMoney(subproject.invoiceAmount);
    const outstandingAmount = roundMoney(subproject.outstandingAmount);
    const receivedAmount = roundMoney(Math.max(0, invoiceAmount - outstandingAmount));
    return {
      客户: joinValues(subproject.customers),
      销售子项目编码: subproject.code,
      销售子项目名称: joinValues(subproject.names),
      起算开票日期: invoice.firstDate,
      超期天数: elapsedDays(invoice.firstDate, asOfDate),
      超期发票数: invoice.invoiceNumbers.size,
      应收单数: subproject.billNumbers.size,
      结算组织: joinValues(subproject.organizations),
      销售部门: joinValues(subproject.departments),
      销售员: joinValues(subproject.salespersons),
      开票金额: invoiceAmount,
      已回款金额: receivedAmount,
      未回款金额: outstandingAmount,
      回款状态: receivedAmount > 0.004 ? "部分回款未结清" : "完全未回款",
    };
  }).filter(Boolean).sort((left, right) => right["未回款金额"] - left["未回款金额"] || right["超期天数"] - left["超期天数"]);

  const completelyUnpaid = rows.filter((row) => row["回款状态"] === "完全未回款");
  const partiallyPaid = rows.filter((row) => row["回款状态"] === "部分回款未结清");
  const outstandingAmount = sumMoney(rows, "未回款金额");
  const customerCount = new Set(rows.map((row) => row["客户"]).filter(Boolean)).size;
  const statistics = {
    asOfDate,
    minimumDays,
    subprojectCount: rows.length,
    invoiceCount: rows.reduce((total, row) => total + row["超期发票数"], 0),
    receivableBillCount: rows.reduce((total, row) => total + row["应收单数"], 0),
    customerCount,
    outstandingAmount,
    completelyUnpaidCount: completelyUnpaid.length,
    completelyUnpaidAmount: sumMoney(completelyUnpaid, "未回款金额"),
    partiallyPaidCount: partiallyPaid.length,
    partiallyPaidAmount: sumMoney(partiallyPaid, "未回款金额"),
    oldestDays: rows.reduce((maximum, row) => Math.max(maximum, row["超期天数"]), 0),
    missingInvoiceDateSubprojects,
    rowsWithoutSubproject,
    partial,
  };
  const amount = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(outstandingAmount);
  const exclusions = [
    missingInvoiceDateSubprojects ? `${missingInvoiceDateSubprojects} 个销售子项目未找到开票日期` : "",
    rowsWithoutSubproject ? `${rowsWithoutSubproject} 条应收明细缺少销售子项目编码` : "",
  ].filter(Boolean);
  const summary = rows.length
    ? `截至 ${asOfDate}，共 ${rows.length} 个销售子项目自开票起超过 ${minimumDays} 天仍未结清，未回款金额 ¥${amount}，涉及 ${customerCount} 家客户${partial ? "（已达到扫描上限，结果可能不完整）" : ""}${exclusions.length ? `；另有${exclusions.join("、")}未纳入` : ""}。`
    : `截至 ${asOfDate}，没有找到自开票起超过 ${minimumDays} 天且仍未结清的销售子项目${exclusions.length ? `；${exclusions.join("、")}未纳入` : ""}。`;
  return { rows, statistics, summary };
}

function normalizeSubprojectKey(value) {
  return String(value || "").trim().toUpperCase();
}

function chunkValues(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function addIfPresent(target, value) {
  const text = String(value || "").trim();
  if (text) target.add(text);
}

function joinValues(values) {
  return [...values].join("、");
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function sumMoney(rows, field) {
  return roundMoney(rows.reduce((total, row) => total + (Number(row[field]) || 0), 0));
}

function summarize(label, rows, truncated) {
  if (!rows.length) return `没有找到符合条件的${label}。`;
  return `找到 ${rows.length} 条${label}${truncated ? "，结果已达到本次返回上限" : ""}。`;
}

function resolveAggregation(item, requested) {
  if (requested !== "sum_amount") return null;
  const field = item.fields.find(([, label]) => /(?:费用金额|价税合计|金额)/.test(label));
  if (!field) throw Object.assign(new Error(`当前${item.label}查询不支持金额汇总。`), { statusCode: 400 });
  return { operation: "sum", field: field[1], label: "总金额", unit: "元" };
}

function calculateAggregate(rows, aggregation, partial) {
  const value = rows.reduce((total, row) => {
    const current = Number(row[aggregation.field]);
    return total + (Number.isFinite(current) ? current : 0);
  }, 0);
  return { ...aggregation, value: Math.round((value + Number.EPSILON) * 100) / 100, records: rows.length, partial };
}

function summarizeAggregate(label, aggregate) {
  if (!aggregate.records) return `没有找到符合条件的${label}，总金额为 0 元。`;
  const amount = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(aggregate.value);
  return `共 ${aggregate.records} 笔${label}，总金额为 ¥${amount}${aggregate.partial ? "（已达到汇总上限，结果可能不完整）" : ""}。`;
}

module.exports = {
  QueryEngine,
  buildFilter,
  rowsToObjects,
  escapeValue,
  resolveAggregation,
  calculateAggregate,
  normalizeMinimumDays,
  businessDate,
  shiftDate,
  buildOverdueReceivableFilter,
  buildOverdueInvoiceFilter,
  aggregateOverdueReceivables,
};
