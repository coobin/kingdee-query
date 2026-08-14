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

function buildOverdueInvoiceCandidateFilter(args, asOfDate) {
  const minimumDays = normalizeMinimumDays(args.minimumDays);
  const cutoffDate = shiftDate(asOfDate, -minimumDays);
  const clauses = [
    "FDocumentStatus='C'",
    "FCancelStatus='A'",
    "FALLAMOUNTFOR<>0",
    `FINVOICEDATE<'${isoDate(cutoffDate)}'`,
  ];
  if (args.customerName) clauses.push(`FCustomerID.FName LIKE '%${escapeValue(args.customerName)}%'`);
  const subprojectNumber = args.subprojectNumber || args.projectNumber;
  if (subprojectNumber) clauses.push(`F_PARA_SaleSubProId.FNumber LIKE '%${escapeValue(subprojectNumber)}%'`);
  return clauses.join(" AND ");
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

function buildSubprojectBatchFilter(subprojectNumbers, extra = []) {
  const quoted = subprojectNumbers.map((value) => `'${escapeValue(value)}'`).join(",");
  return [...extra, `F_PARA_SaleSubProId.FNumber IN (${quoted})`].join(" AND ");
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
    const minimumDays = normalizeMinimumDays(args.minimumDays);
    const cutoffDate = shiftDate(asOfDate, -minimumDays);
    const accepted = { asOfDate, minimumDays, cutoffDate };
    if (args.customerName) accepted.customerName = args.customerName;
    if (args.subprojectNumber || args.projectNumber) accepted.subprojectNumber = args.subprojectNumber || args.projectNumber;
    const limit = normalizeLimit(args.limit, this.config.kingdee.maxRows);
    const pageSize = this.config.kingdee.queryPageSize || 5000;
    const invoiceSource = item.invoiceDateSource;
    if (!invoiceSource) throw new Error("超期未回款查询缺少开票日期来源配置。");
    const rawInvoiceRows = await this.queryAllPages(identity, {
      FormId: invoiceSource.formId,
      FieldKeys: invoiceSource.fields.map(([key]) => key).join(","),
      FilterString: buildOverdueInvoiceCandidateFilter(args, asOfDate),
      OrderString: invoiceSource.defaultOrder || "FINVOICEDATE ASC,FBillNo ASC",
      TopRowCount: 0,
    }, pageSize);
    const overdueInvoiceRows = rowsToObjects(rawInvoiceRows, invoiceSource.fields);
    const candidateSubprojects = [...new Set(overdueInvoiceRows.map((row) => String(row["销售子项目编码"] || "").trim()).filter(Boolean))];
    // The first invoice query identifies overdue candidates. Fetch every valid
    // invoice for those subprojects so amounts describe the complete
    // subproject, while the candidate rows remain the aging source.
    const allInvoices = await this.queryBySubprojects(
      identity,
      invoiceSource,
      candidateSubprojects,
      ["FDocumentStatus='C'", "FCancelStatus='A'", "FALLAMOUNTFOR<>0"],
      pageSize,
    );
    const invoiceRows = rowsToObjects(allInvoices.rows, invoiceSource.fields);
    const receivableSource = { ...item, fields: item.fields };
    const receivables = await this.queryBySubprojects(identity, receivableSource, candidateSubprojects, ["FDocumentStatus='C'", "FCancelStatus='A'", "FIVALLAMOUNTFOR>0"], pageSize);
    const receiptSource = item.receiptSource;
    const refundSource = item.refundSource;
    const receipts = receiptSource
      ? await this.queryBySubprojects(identity, receiptSource, candidateSubprojects, ["FDocumentStatus='C'", "FCancelStatus='A'"], pageSize)
      : { rows: [] };
    const refunds = refundSource
      ? await this.queryBySubprojects(identity, refundSource, candidateSubprojects, ["FDocumentStatus='C'", "FCancelStatus='A'"], pageSize)
      : { rows: [] };
    const paymentConditionSource = item.paymentConditionSource;
    const paymentConditions = paymentConditionSource
      ? await this.queryBySubprojects(identity, paymentConditionSource, candidateSubprojects, ["FDocumentStatus='C'", "FCancelStatus='A'"], pageSize)
      : { rows: [] };
    const result = aggregateOverdueReceivables(rowsToObjects(receivables.rows, item.fields), {
      invoiceRows,
      overdueInvoiceRows,
      receiptRows: receiptSource ? rowsToObjects(receipts.rows, receiptSource.fields) : [],
      refundRows: refundSource ? rowsToObjects(refunds.rows, refundSource.fields) : [],
      paymentConditionRows: paymentConditionSource ? rowsToObjects(paymentConditions.rows, paymentConditionSource.fields) : [],
      asOfDate,
      minimumDays,
      partial: false,
    });
    return {
      tool: "overdue_receivables",
      label: item.label,
      query: accepted,
      columns: item.publicColumns,
      rows: result.rows.slice(0, limit),
      count: result.rows.length,
      truncated: result.rows.length > limit,
      statistics: result.statistics,
      summary: result.summary,
    };
  }

  async queryAllPages(identity, request, pageSize) {
    const rows = [];
    let startRow = 0;
    while (true) {
      const page = await this.kingdee.executeBillQuery(identity.kingdeeUsername, {
        ...request,
        StartRow: startRow,
        Limit: pageSize,
      });
      rows.push(...page);
      if (page.length < pageSize) break;
      startRow += page.length;
    }
    return rows;
  }

  async queryBySubprojects(identity, source, subprojects, extraFilter, pageSize) {
    if (!subprojects.length) return { rows: [] };
    const rows = [];
    for (const batch of chunkValues(subprojects, 150)) {
      rows.push(...await this.queryAllPages(identity, {
        FormId: source.formId,
        FieldKeys: source.fields.map(([key]) => key).join(","),
        FilterString: buildSubprojectBatchFilter(batch, extraFilter),
        OrderString: source.defaultOrder || "FDATE ASC,FBillNo ASC",
        TopRowCount: 0,
      }, pageSize));
    }
    return { rows };
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

function aggregateOverdueReceivables(sourceRows, { invoiceRows = [], overdueInvoiceRows = [], receiptRows = [], refundRows = [], paymentConditionRows = [], asOfDate, minimumDays, partial = false }) {
  // The full invoice set is used for amount reconciliation, while the
  // candidate set is the source of the aging date and overdue invoice count.
  // Keep the fallback for direct callers that predate this distinction.
  const candidateInvoiceRows = overdueInvoiceRows.length ? overdueInvoiceRows : invoiceRows;
  // Treat the date predicate as a server-side invariant as well.  Kingdee's
  // query endpoint is the source of the candidate set, but a malformed or
  // ignored remote filter must never let a future invoice become the aging
  // start date in the returned list.
  const cutoffDate = asOfDate && Number.isInteger(minimumDays) ? shiftDate(asOfDate, -minimumDays) : "";
  const agingInvoiceRows = cutoffDate
    ? candidateInvoiceRows.filter((row) => {
      const invoiceDate = String(row["开票日期"] || "").slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) && invoiceDate < cutoffDate;
    })
    : candidateInvoiceRows;
  const subprojects = new Map();
  let rowsWithoutSubproject = 0;
  const getSubproject = (row, codeValue = row["销售子项目编码"]) => {
    const code = String(codeValue || "").trim();
    if (!code) return null;
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
        invoiceNumbers: new Set(),
        overdueInvoiceNumbers: new Set(),
        firstOverdueInvoiceDate: "",
        paymentConditions: new Set(),
        invoiceAmount: 0,
        receivableAmount: 0,
        outstandingAmount: 0,
        writtenOffAmount: 0,
        actualReceiptAmount: 0,
        refundAmount: 0,
        writtenOffBills: new Set(),
        writtenOffKnown: false,
      };
      subprojects.set(key, subproject);
    }
    return subproject;
  };

  for (const row of agingInvoiceRows) {
    const subproject = getSubproject(row);
    if (!subproject) continue;
    addIfPresent(subproject.names, row["销售子项目名称"]);
    addIfPresent(subproject.customers, row["客户"]);
    addIfPresent(subproject.overdueInvoiceNumbers, row["销售发票号"]);
    const invoiceDate = String(row["开票日期"] || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) && (!subproject.firstOverdueInvoiceDate || invoiceDate < subproject.firstOverdueInvoiceDate)) {
      subproject.firstOverdueInvoiceDate = invoiceDate;
    }
  }

  for (const row of invoiceRows) {
    const subproject = getSubproject(row);
    if (!subproject) { rowsWithoutSubproject += 1; continue; }
    addIfPresent(subproject.names, row["销售子项目名称"]);
    addIfPresent(subproject.customers, row["客户"]);
    addIfPresent(subproject.invoiceNumbers, row["销售发票号"]);
    subproject.invoiceAmount += signedInvoiceAmount(row);
  }

  for (const row of paymentConditionRows) {
    const subproject = getSubproject(row);
    if (!subproject) { rowsWithoutSubproject += 1; continue; }
    addIfPresent(subproject.names, row["销售子项目名称"]);
    addIfPresent(subproject.paymentConditions, row["收款条件"]);
  }

  for (const row of sourceRows) {
    const subproject = getSubproject(row);
    if (!subproject) { rowsWithoutSubproject += 1; continue; }
    addIfPresent(subproject.names, row["销售子项目名称"]);
    addIfPresent(subproject.customers, row["客户"]);
    addIfPresent(subproject.billNumbers, row["应收单号"]);
    addIfPresent(subproject.organizations, row["结算组织"]);
    addIfPresent(subproject.departments, row["销售部门"]);
    const invoiceAmount = Math.max(0, Number(row["已开票金额"]) || 0);
    const receivedAmount = Math.max(0, Number(row["已收金额"]) || 0);
    const entryOutstanding = Math.max(0, Number(row["未收金额"]) || 0);
    subproject.receivableAmount += invoiceAmount;
    // Keep the risk amount bounded by the invoiced portion of each receivable entry.
    subproject.outstandingAmount += Math.min(entryOutstanding, Math.max(0, invoiceAmount - receivedAmount));
    const billKey = String(row["应收内码"] || row["应收单号"] || "").trim();
    if (billKey && !subproject.writtenOffBills.has(billKey)) {
      subproject.writtenOffBills.add(billKey);
      if (row["已核销金额"] != null && Number.isFinite(Number(row["已核销金额"]))) {
        subproject.writtenOffKnown = true;
        subproject.writtenOffAmount += Math.max(0, Number(row["已核销金额"]) || 0);
      }
    }
  }

  for (const row of receiptRows) {
    const subproject = getSubproject(row);
    if (!subproject) { rowsWithoutSubproject += 1; continue; }
    addIfPresent(subproject.names, row["销售子项目名称"]);
    subproject.actualReceiptAmount += Math.max(0, Number(row["收款金额"]) || 0);
  }
  for (const row of refundRows) {
    const subproject = getSubproject(row);
    if (!subproject) { rowsWithoutSubproject += 1; continue; }
    addIfPresent(subproject.names, row["销售子项目名称"]);
    subproject.refundAmount += Math.max(0, Number(row["退款金额"]) || 0);
  }

  let missingInvoiceDateSubprojects = 0;
  const rows = [...subprojects.values()].map((subproject) => {
    if (!subproject.firstOverdueInvoiceDate) { missingInvoiceDateSubprojects += 1; return null; }
    const firstDate = subproject.firstOverdueInvoiceDate;
    const invoiceAmount = roundMoney(subproject.invoiceNumbers.size ? subproject.invoiceAmount : subproject.receivableAmount);
    const outstandingAmount = roundMoney(subproject.outstandingAmount);
    const actualReceiptAmount = roundMoney(subproject.actualReceiptAmount - subproject.refundAmount);
    const fallbackWrittenOff = Math.max(0, subproject.receivableAmount - outstandingAmount);
    const writtenOffAmount = roundMoney(subproject.writtenOffKnown ? subproject.writtenOffAmount : fallbackWrittenOff);
    const unreconciledAmount = roundMoney(Math.max(0, actualReceiptAmount - writtenOffAmount));
    const unreceiptedInvoiceAmount = roundMoney(Math.max(0, invoiceAmount - subproject.receivableAmount));
    const hasRisk = outstandingAmount > 0.004 || unreceiptedInvoiceAmount > 0.004;
    if (!hasRisk) return null;
    let status = "完全未回款";
    if (unreceiptedInvoiceAmount > 0.004) {
      status = subproject.receivableAmount > 0.004 ? "未完全形成应收" : "完全未形成应收";
    }
    else if (outstandingAmount <= 0.004) status = "已结清";
    else if (actualReceiptAmount > 0.004 || writtenOffAmount > 0.004) status = "部分回款未结清";
    return {
      客户: joinValues(subproject.customers),
      销售子项目编码: subproject.code,
      销售子项目名称: joinValues(subproject.names),
      收款条件: joinValues(subproject.paymentConditions),
      开票日期: firstDate,
      超期天数: elapsedDays(firstDate, asOfDate),
      超期发票数: subproject.overdueInvoiceNumbers.size,
      应收单数: subproject.billNumbers.size,
      结算组织: joinValues(subproject.organizations),
      销售部门: joinValues(subproject.departments),
      开票金额: invoiceAmount,
      实际回款净额: actualReceiptAmount,
      未核销金额: unreconciledAmount,
      未生成应收金额: unreceiptedInvoiceAmount,
      未回款金额: outstandingAmount,
      回款状态: status,
    };
  }).filter(Boolean).sort((left, right) => right["未回款金额"] - left["未回款金额"] || right["未生成应收金额"] - left["未生成应收金额"] || right["超期天数"] - left["超期天数"]);

  const completelyUnpaid = rows.filter((row) => row["回款状态"] === "完全未回款");
  const partiallyPaid = rows.filter((row) => row["回款状态"] === "部分回款未结清");
  const unreceipted = rows.filter((row) => row["未生成应收金额"] > 0.004);
  const fullyUnreceipted = rows.filter((row) => row["回款状态"] === "完全未形成应收");
  const partiallyUnreceipted = rows.filter((row) => row["回款状态"] === "未完全形成应收");
  const outstandingAmount = sumMoney(rows, "未回款金额");
  const actualReceiptAmount = sumMoney(rows, "实际回款净额");
  const unreconciledAmount = sumMoney(rows, "未核销金额");
  const unreceiptedInvoiceAmount = sumMoney(rows, "未生成应收金额");
  const customerCount = new Set(rows.map((row) => row["客户"]).filter(Boolean)).size;
  const statistics = {
    asOfDate,
    minimumDays,
    subprojectCount: rows.length,
    invoiceCount: rows.reduce((total, row) => total + row["超期发票数"], 0),
    receivableBillCount: rows.reduce((total, row) => total + row["应收单数"], 0),
    customerCount,
    outstandingAmount,
    actualReceiptAmount,
    unreconciledAmount,
    unreceiptedInvoiceAmount,
    completelyUnpaidCount: completelyUnpaid.length,
    completelyUnpaidAmount: sumMoney(completelyUnpaid, "未回款金额"),
    partiallyPaidCount: partiallyPaid.length,
    partiallyPaidAmount: sumMoney(partiallyPaid, "未回款金额"),
    unreceiptedCount: unreceipted.length,
    fullyUnreceiptedCount: fullyUnreceipted.length,
    fullyUnreceiptedAmount: sumMoney(fullyUnreceipted, "未生成应收金额"),
    partiallyUnreceiptedCount: partiallyUnreceipted.length,
    partiallyUnreceiptedAmount: sumMoney(partiallyUnreceipted, "未生成应收金额"),
    // Deprecated aliases retained for existing API consumers.
    invoiceOnlyCount: unreceipted.length,
    invoiceOnlyAmount: sumMoney(unreceipted, "未生成应收金额"),
    oldestDays: rows.reduce((maximum, row) => Math.max(maximum, row["超期天数"]), 0),
    missingInvoiceDateSubprojects,
    rowsWithoutSubproject,
    partial,
  };
  const amount = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(outstandingAmount);
  const exclusions = [
    missingInvoiceDateSubprojects ? `${missingInvoiceDateSubprojects} 个销售子项目未找到开票日期` : "",
    rowsWithoutSubproject ? `${rowsWithoutSubproject} 条明细缺少销售子项目编码` : "",
  ].filter(Boolean);
  const summary = rows.length
    ? `截至 ${asOfDate}，共 ${rows.length} 个销售子项目以第一张超期发票的开票日期起算超过 ${minimumDays} 天，未回款金额 ¥${amount}${unreceipted.length ? `，其中 ${unreceipted.length} 个尚未完全形成应收（完全未形成 ${fullyUnreceipted.length} 个，已部分形成 ${partiallyUnreceipted.length} 个）` : ""}${partial ? "（已达到扫描上限，结果可能不完整）" : ""}${exclusions.length ? `；另有${exclusions.join("、")}未纳入` : ""}。`
    : `截至 ${asOfDate}，没有找到以第一张超期发票的开票日期起算超过 ${minimumDays} 天且存在未回款或未生成应收金额的销售子项目${exclusions.length ? `；${exclusions.join("、")}未纳入` : ""}。`;
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

function signedInvoiceAmount(row) {
  const amount = Number(row["发票金额"]) || 0;
  const redBlue = String(row["红蓝字标识"] || "").trim();
  return redBlue === "1" && amount > 0 ? -amount : amount;
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
  buildOverdueInvoiceCandidateFilter,
  buildOverdueInvoiceFilter,
  aggregateOverdueReceivables,
};
