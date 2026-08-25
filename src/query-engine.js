const { KingdeeError } = require("./kingdee");
const { buildInventoryCycleResult, warehouseStage } = require("./inventory-cycle");

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

const workflowColumns = ["单据编号", "流程名称", "当前节点", "当前处理人", "节点到达时间", "发起时间", "状态"];
const workflowFieldKeys = [
  "FNumber",
  "FCreateTime",
  "FProcDefName",
  "FStatus",
  "FAssignCreateTime",
  "FRECEIVERNAMES",
  "FACTIVITYNAME",
];

function workflowBillNumber(processNumber) {
  const value = String(processNumber || "").trim();
  const matched = value.match(/^(.+)_\d{14}$/);
  return matched ? matched[1] : value;
}

function workflowRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    单据编号: workflowBillNumber(row[0]),
    流程名称: row[2] || "",
    当前节点: row[6] || "",
    当前处理人: row[5] || "",
    节点到达时间: row[4] || "",
    发起时间: row[1] || "",
    状态: String(row[3] || "") === "2" ? "审批中" : (row[3] || ""),
  }));
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

function buildReceivableAgingCandidateFilter(args, asOfDate) {
  const minimumDays = normalizeMinimumDays(args.minimumDays);
  const cutoffDate = shiftDate(asOfDate, -minimumDays);
  const clauses = [
    "FDocumentStatus='C'",
    "FCancelStatus='A'",
    "FALLAMOUNTFOR<>0",
    "FNORECEIVEAMOUNT>0",
    `FDate<'${isoDate(cutoffDate)}'`,
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

function buildSubprojectBatchFilter(subprojectNumbers, extra = [], field = "F_PARA_SaleSubProId.FNumber") {
  const quoted = subprojectNumbers.map((value) => `'${escapeValue(value)}'`).join(",");
  return [...extra, `${field} IN (${quoted})`].join(" AND ");
}

function buildInFilter(field, values) {
  const quoted = values.map((value) => `'${escapeValue(value)}'`).join(",");
  return `${field} IN (${quoted})`;
}

function buildBillBatchFilter(billNumbers) {
  const quoted = billNumbers.map((value) => `'${escapeValue(value)}'`).join(",");
  return `(FSRCBILLNO IN (${quoted}) OR FTargetBillNO IN (${quoted}))`;
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

function combinedBaseData(number, name) {
  const cleanNumber = String(number || "").trim();
  const cleanName = String(name || "").trim();
  if (cleanNumber && cleanName && cleanNumber !== cleanName) return `${cleanNumber} · ${cleanName}`;
  return cleanName || cleanNumber;
}

function combinedDateRange(from, to) {
  const start = String(from || "").slice(0, 10);
  const end = String(to || "").slice(0, 10);
  if (start && end && start !== end) return `${start} 至 ${end}`;
  return start || end;
}

function mapExpenseDetailRows(rows, source) {
  return rowsToObjects(rows, source.fields, source.valueMappings).map((row, index) => ({
    序号: index + 1,
    费用项目: row.费用项目 || "",
    报销类型: row.报销类型 || "",
    费用承担部门: row.费用承担部门 || "",
    销售项目: combinedBaseData(row.销售项目编码, row.销售项目名称),
    销售子项目: combinedBaseData(row.销售子项目编码, row.销售子项目名称),
    费用日期: combinedDateRange(row.费用开始日期, row.费用结束日期),
    备注: row.备注 || "",
    费用金额: roundMoney(row.费用金额),
    税额: roundMoney(row.税额),
    申请报销金额: roundMoney(row.申请报销金额),
    核定报销金额: roundMoney(row.核定报销金额),
    未付款金额: roundMoney(row.未付款金额),
  }));
}

function personnelCostDateRange(args, maximumDays = 366) {
  if (!args.dateFrom || !args.dateTo) {
    throw Object.assign(new Error("人员成本查询必须填写开始日期和结束日期。"), { statusCode: 400 });
  }
  const dateFrom = isoDate(args.dateFrom);
  const dateTo = isoDate(args.dateTo);
  if (dateFrom > dateTo) {
    throw Object.assign(new Error("开始日期不能晚于结束日期。"), { statusCode: 400 });
  }
  const days = elapsedDays(dateFrom, dateTo) + 1;
  if (days > maximumDays) {
    throw Object.assign(new Error(`人员成本查询范围最多为 ${maximumDays} 天。`), { statusCode: 400 });
  }
  return { dateFrom, dateTo, dateToExclusive: nextDay(dateTo), days };
}

function buildPersonnelCostFilters(args, range) {
  const common = [
    "FDocumentStatus='C'",
    `FDate>='${range.dateFrom}'`,
    `FDate<'${range.dateToExclusive}'`,
  ];
  const payroll = [...common];
  const expense = [...common];
  if (args.employeeNumber) {
    const value = escapeValue(args.employeeNumber);
    payroll.push(`FEmpInfoId.FNumber='${value}'`);
    expense.push(`FProposerID.FNumber='${value}'`);
  }
  if (args.employeeName) {
    const value = escapeValue(args.employeeName);
    payroll.push(`FEmpInfoId.FName LIKE '%${value}%'`);
    expense.push(`FProposerID.FName LIKE '%${value}%'`);
  }
  if (args.departmentName) {
    const value = escapeValue(args.departmentName);
    payroll.push(`FStaffDeptId.FName LIKE '%${value}%'`);
    expense.push(`FRequestDeptID.FName LIKE '%${value}%'`);
  }
  return { payroll: payroll.join(" AND "), expense: expense.join(" AND ") };
}

function personnelKey(number, name) {
  const cleanNumber = String(number || "").normalize("NFKC").trim().toUpperCase();
  if (cleanNumber) return `number:${cleanNumber}`;
  return `name:${String(name || "").normalize("NFKC").trim()}`;
}

function aggregatePersonnelCost(payrollRows, expenseRows, range) {
  const currencies = new Set([
    ...payrollRows.map((row) => String(row.工资币别 || "").trim()),
    ...expenseRows.map((row) => String(row.报销币别 || "").trim()),
  ].filter(Boolean));
  if (currencies.size > 1) {
    throw Object.assign(new Error("所选期间包含多个币别，不能直接相加计算人员成本。请缩小查询范围或先统一币别。"), { statusCode: 422 });
  }
  const people = new Map();
  const ensurePerson = (number, name) => {
    const key = personnelKey(number, name);
    if (!people.has(key)) {
      people.set(key, {
        员工编号: String(number || "").trim(),
        姓名: String(name || "").trim(),
        所属部门: "",
        实发工资: 0,
        报销金额: 0,
        人员成本: 0,
        工资单数: 0,
        报销单数: 0,
        数据构成: "",
      });
    }
    const person = people.get(key);
    if (!person.员工编号 && number) person.员工编号 = String(number).trim();
    if (!person.姓名 && name) person.姓名 = String(name).trim();
    return person;
  };

  for (const row of payrollRows) {
    const person = ensurePerson(row.员工编号, row.姓名);
    if (row.所属部门) person.所属部门 = String(row.所属部门).trim();
    person.实发工资 = roundMoney(person.实发工资 + (Number(row.实发工资) || 0));
    person.工资单数 += 1;
  }
  for (const row of expenseRows) {
    const person = ensurePerson(row.员工编号, row.姓名);
    if (!person.所属部门 && row.申请部门) person.所属部门 = String(row.申请部门).trim();
    person.报销金额 = roundMoney(person.报销金额 + (Number(row.核定报销金额) || 0));
    person.报销单数 += 1;
  }

  const rows = [...people.values()].map((person) => {
    person.人员成本 = roundMoney(person.实发工资 + person.报销金额);
    person.数据构成 = person.工资单数 && person.报销单数 ? "工资 + 报销" : (person.工资单数 ? "仅工资" : "仅报销");
    return person;
  }).sort((left, right) => right.人员成本 - left.人员成本
    || String(left.员工编号).localeCompare(String(right.员工编号), "zh-CN", { numeric: true }));

  const statistics = {
    type: "personnel_cost",
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    personnelCount: rows.length,
    payrollAmount: sumMoney(rows, "实发工资"),
    expenseAmount: sumMoney(rows, "报销金额"),
    totalCost: sumMoney(rows, "人员成本"),
    payrollDocuments: payrollRows.length,
    expenseDocuments: expenseRows.length,
    bothCount: rows.filter((row) => row.工资单数 && row.报销单数).length,
    payrollOnlyCount: rows.filter((row) => row.工资单数 && !row.报销单数).length,
    expenseOnlyCount: rows.filter((row) => !row.工资单数 && row.报销单数).length,
    currencyCode: [...currencies][0] || "",
  };
  const amount = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(statistics.totalCost);
  const summary = rows.length
    ? `${range.dateFrom} 至 ${range.dateTo} 共 ${rows.length} 人，人员成本合计 ¥${amount}。`
    : `${range.dateFrom} 至 ${range.dateTo} 没有找到已审核的工资单或费用报销单。`;
  return { rows, statistics, summary };
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
    if (item.queryType === "receivable_aging") return this.receivableAging(identity, item, args);
    if (item.queryType === "overdue_risk_combined") return this.overdueRiskCombined(identity, item, args);
    if (item.queryType === "inventory_cycle") return this.inventoryCycle(identity, item, args);
    if (item.queryType === "personnel_cost") return this.personnelCost(identity, item, args);
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

  async expenseDetails(identity, billNumber) {
    const item = this.catalog.expense_claims;
    const source = item?.detailSource;
    if (!item || !source) throw Object.assign(new Error("费用报销明细查询尚未配置。"), { statusCode: 503 });
    const normalizedBillNumber = String(billNumber || "").trim();
    if (!normalizedBillNumber || normalizedBillNumber.length > 80) {
      throw Object.assign(new Error("单据编号不正确。"), { statusCode: 400 });
    }
    const { filter } = buildFilter(item, { billNumber: normalizedBillNumber }, identity, this.config);
    const headerRows = await this.kingdee.executeBillQuery(identity.kingdeeUsername, {
      FormId: item.formId,
      FieldKeys: "FBillNo,FExpAmountSum",
      FilterString: filter,
      OrderString: "",
      StartRow: 0,
      Limit: 1,
      TopRowCount: 0,
    });
    if (!headerRows.length) {
      throw Object.assign(new Error("没有找到这张费用报销单，或当前账号无权查看。"), { statusCode: 404 });
    }
    const maximum = Math.min(Math.max(Number(source.maxRows) || 200, 1), 500);
    const rawRows = await this.kingdee.executeBillQuery(identity.kingdeeUsername, {
      FormId: item.formId,
      FieldKeys: source.fields.map(([key]) => key).join(","),
      FilterString: filter,
      OrderString: source.defaultOrder || "FEntity_FENTRYID ASC",
      StartRow: 0,
      Limit: maximum + 1,
      TopRowCount: 0,
    });
    const truncated = rawRows.length > maximum;
    const rows = mapExpenseDetailRows(rawRows.slice(0, maximum), source);
    const totals = Object.fromEntries(source.amountColumns.map((column) => [
      column,
      roundMoney(rows.reduce((sum, row) => sum + (Number(row[column]) || 0), 0)),
    ]));
    const headerAmount = roundMoney(headerRows[0][1]);
    const detailAmount = totals["申请报销金额"] || 0;
    const difference = roundMoney(headerAmount - detailAmount);
    return {
      tool: "expense_claims",
      label: "费用报销明细",
      billNumber: normalizedBillNumber,
      columns: source.publicColumns,
      rows,
      count: rows.length,
      truncated,
      totals,
      reconciliation: {
        headerAmount,
        detailAmount,
        difference,
        matches: Math.abs(difference) < 0.01,
      },
      summary: truncated ? `已显示前 ${maximum} 条报销明细` : `共 ${rows.length} 条报销明细`,
    };
  }

  async personnelCost(identity, item, args) {
    const range = personnelCostDateRange(args, item.maxPeriodDays || 366);
    const filters = buildPersonnelCostFilters(args, range);
    const pageSize = this.config.kingdee.queryPageSize || 5000;
    const expenseSource = item.expenseSource;
    if (!expenseSource) throw new Error("人员成本查询缺少费用报销来源配置。");
    const [rawPayrollRows, rawExpenseRows] = await Promise.all([
      this.queryAllPages(identity, {
        FormId: item.formId,
        FieldKeys: item.fields.map(([key]) => key).join(","),
        FilterString: filters.payroll,
        OrderString: item.defaultOrder || "FDate ASC,FBillNo ASC",
        TopRowCount: 0,
      }, pageSize),
      this.queryAllPages(identity, {
        FormId: expenseSource.formId,
        FieldKeys: expenseSource.fields.map(([key]) => key).join(","),
        FilterString: filters.expense,
        OrderString: expenseSource.defaultOrder || "FDate ASC,FBillNo ASC",
        TopRowCount: 0,
      }, pageSize),
    ]);
    const payrollRows = rowsToObjects(rawPayrollRows, item.fields);
    const expenseRows = rowsToObjects(rawExpenseRows, expenseSource.fields);
    const aggregated = aggregatePersonnelCost(payrollRows, expenseRows, range);
    const query = {
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      ...(args.employeeNumber ? { employeeNumber: args.employeeNumber } : {}),
      ...(args.employeeName ? { employeeName: args.employeeName } : {}),
      ...(args.departmentName ? { departmentName: args.departmentName } : {}),
      status: "已审核",
    };
    return {
      tool: "personnel_cost",
      label: item.label,
      query,
      columns: item.publicColumns,
      rows: aggregated.rows,
      count: aggregated.rows.length,
      truncated: false,
      partial: false,
      statistics: aggregated.statistics,
      summary: aggregated.summary,
    };
  }

  async overdueReceivables(identity, item, args, { returnAll = false } = {}) {
    const asOfDate = businessDate(this.now());
    const minimumDays = normalizeMinimumDays(args.minimumDays);
    const cutoffDate = shiftDate(asOfDate, -minimumDays);
    const accepted = { asOfDate, minimumDays, cutoffDate };
    if (args.customerName) accepted.customerName = args.customerName;
    if (args.subprojectNumber || args.projectNumber) accepted.subprojectNumber = args.subprojectNumber || args.projectNumber;
    const limit = returnAll ? Number.MAX_SAFE_INTEGER : normalizeLimit(args.limit, this.config.kingdee.maxRows);
    const pageSize = this.config.kingdee.queryPageSize || 5000;
    const invoiceSource = item.invoiceDateSource;
    if (!invoiceSource) throw new Error("发票账龄查询缺少开票日期来源配置。");
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
    const receivableRows = rowsToObjects(receivables.rows, item.fields);
    const receiptWriteoffSource = item.receiptWriteoffSource;
    const receiptWriteoffs = receiptWriteoffSource
      ? await this.queryByBillNumbers(identity, receiptWriteoffSource, [...new Set(receivableRows.map((row) => String(row["应收单号"] || "").trim()).filter(Boolean))], pageSize)
      : { rows: [] };
    const invoiceWriteoffSource = item.invoiceWriteoffSource;
    const invoiceWriteoffs = invoiceWriteoffSource
      ? await this.queryBySubprojects(identity, invoiceWriteoffSource, candidateSubprojects, [], pageSize)
      : { rows: [] };
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
      ? await this.queryBySubprojects(identity, paymentConditionSource, candidateSubprojects, paymentConditionSource.filters || ["FDocumentStatus='C'", "FCancelStatus='A'"], pageSize)
      : { rows: [] };
    const result = aggregateOverdueReceivables(receivableRows, {
      invoiceRows,
      overdueInvoiceRows,
      receiptWriteoffRows: receiptWriteoffSource ? rowsToObjects(receiptWriteoffs.rows, receiptWriteoffSource.fields) : [],
      invoiceWriteoffRows: invoiceWriteoffSource ? rowsToObjects(invoiceWriteoffs.rows, invoiceWriteoffSource.fields) : [],
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

  async receivableAging(identity, item, args, { returnAll = false } = {}) {
    const asOfDate = businessDate(this.now());
    const { filter, accepted } = buildReceivableAgingCandidateFilter(args, asOfDate);
    const limit = returnAll ? Number.MAX_SAFE_INTEGER : normalizeLimit(args.limit, this.config.kingdee.maxRows);
    const pageSize = this.config.kingdee.queryPageSize || 5000;
    const rawRows = await this.queryAllPages(identity, {
      FormId: item.formId,
      FieldKeys: item.fields.map(([key]) => key).join(","),
      FilterString: filter,
      OrderString: item.defaultOrder || "FDate ASC,FBillNo ASC",
      TopRowCount: 0,
    }, pageSize);
    const receivableRows = rowsToObjects(rawRows, item.fields);
    const candidateSubprojects = [...new Set(receivableRows.map((row) => String(row["销售子项目编码"] || "").trim()).filter(Boolean))];
    const invoiceWriteoffSource = item.invoiceWriteoffSource;
    const invoiceWriteoffs = invoiceWriteoffSource
      ? await this.queryBySubprojects(identity, invoiceWriteoffSource, candidateSubprojects, [], pageSize)
      : { rows: [] };
    const paymentConditionSource = item.paymentConditionSource;
    const paymentConditions = paymentConditionSource
      ? await this.queryBySubprojects(identity, paymentConditionSource, candidateSubprojects, paymentConditionSource.filters || [], pageSize)
      : { rows: [] };
    const result = aggregateReceivableAging(receivableRows, {
      invoiceWriteoffRows: invoiceWriteoffSource ? rowsToObjects(invoiceWriteoffs.rows, invoiceWriteoffSource.fields) : [],
      paymentConditionRows: paymentConditionSource ? rowsToObjects(paymentConditions.rows, paymentConditionSource.fields) : [],
      asOfDate,
      minimumDays: accepted.minimumDays,
      partial: false,
    });
    return {
      tool: "receivable_aging",
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

  async overdueRiskCombined(identity, item, args) {
    const invoiceDays = normalizeMinimumDays(args.invoiceDays == null || args.invoiceDays === "" ? 180 : args.invoiceDays);
    const receivableDays = normalizeMinimumDays(args.receivableDays == null || args.receivableDays === "" ? 270 : args.receivableDays);
    const limit = Number.MAX_SAFE_INTEGER;
    const sharedArgs = { ...args };
    const returnAll = { returnAll: true };
    const [invoiceResult, receivableResult] = await Promise.all([
      this.overdueReceivables(identity, this.catalog.overdue_receivables, { ...sharedArgs, minimumDays: invoiceDays }, returnAll),
      this.receivableAging(identity, this.catalog.receivable_aging, { ...sharedArgs, minimumDays: receivableDays }, returnAll),
    ]);
    const result = aggregateOverdueRiskCombined(invoiceResult, receivableResult, { invoiceDays, receivableDays });
    return {
      tool: "overdue_risk_combined",
      label: item.label,
      query: {
        asOfDate: invoiceResult.query.asOfDate,
        invoiceDays,
        receivableDays,
        ...(args.customerName ? { customerName: args.customerName } : {}),
        ...((args.subprojectNumber || args.projectNumber) ? { subprojectNumber: args.subprojectNumber || args.projectNumber } : {}),
      },
      columns: item.publicColumns,
      rows: result.rows.slice(0, limit),
      count: result.rows.length,
      truncated: result.rows.length > limit || invoiceResult.truncated || receivableResult.truncated,
      statistics: result.statistics,
      summary: result.summary,
    };
  }

  async inventoryCycle(identity, item, args) {
    const hasScopeFilter = [args.materialNumber, args.materialName, args.warehouseName, args.subprojectNumber].some((value) => String(value || "").trim())
      || ["company", "project", "customer"].includes(String(args.warehouseScope || ""));
    if (!hasScopeFilter) {
      throw Object.assign(new Error("请至少填写物料编码、物料名称、仓库名称或销售子项目编码中的一项，不能只填写最少库存周期。"), { statusCode: 400 });
    }
    const asOfDate = args.asOfDate ? isoDate(args.asOfDate) : businessDate(this.now());
    const limit = normalizeLimit(args.limit, this.config.kingdee.maxRows);
    const pageSize = this.config.kingdee.queryPageSize || 5000;
    const sources = item;
    const warehouseRows = rowsToObjects(await this.queryAllPages(identity, {
      FormId: sources.warehouseSource.formId,
      FieldKeys: sources.warehouseSource.fields.map(([key]) => key).join(","),
      FilterString: "FForbidStatus='A'",
      OrderString: sources.warehouseSource.defaultOrder || "FNumber ASC",
      TopRowCount: 0,
    }, pageSize), sources.warehouseSource.fields);
    const allWarehouses = warehouseRows.map((row) => ({
      ...row,
      stage: warehouseStage(row["仓库名称"]),
    })).filter((row) => ["公司仓", "项目仓", "客户仓"].includes(row.stage)
      && (row.stage === "公司仓" || String(row["销售项目编码"] || "").trim() || String(row["销售子项目编码"] || "").trim()));
    const selectedWarehouses = allWarehouses.filter((row) => this.matchesInventoryWarehouse(row, args));
    const selectedCodes = [...new Set(selectedWarehouses.map((row) => String(row["仓库编码"] || "").trim()).filter(Boolean))];
    const selectedSubprojects = new Set(selectedWarehouses.map((row) => String(row["销售子项目编码"] || "").trim()).filter(Boolean));
    const relatedWarehouses = allWarehouses.filter((row) => {
      const code = String(row["仓库编码"] || "").trim();
      const subproject = String(row["销售子项目编码"] || "").trim();
      return selectedCodes.includes(code) || (subproject && selectedSubprojects.has(subproject));
    });
    const relatedCodes = [...new Set(relatedWarehouses.map((row) => String(row["仓库编码"] || "").trim()).filter(Boolean))];
    const materialFilters = [];
    if (args.materialNumber) materialFilters.push(`FMaterialId.FNumber='${escapeValue(args.materialNumber)}'`);
    if (args.materialName) materialFilters.push(`FMaterialId.FName LIKE '%${escapeValue(args.materialName)}%'`);
    const currentRows = rowsToObjects(await this.queryByCodeBatches(identity, sources.inventorySource, selectedCodes, "FStockId.FNumber", ["FBaseQty<>0", ...materialFilters], pageSize), sources.inventorySource.fields);
    const movementFilters = ["FDocumentStatus='C'", "FCancelStatus='A'", `FDate<'${nextDay(asOfDate)}'`, ...materialFilters];
    if (args.subprojectNumber) movementFilters.push(`F_PARA_SaleSubProId.FNumber LIKE '%${escapeValue(args.subprojectNumber)}%'`);
    const inboundRows = rowsToObjects(await this.queryByCodeBatches(identity, sources.inboundSource, relatedCodes, "FStockId.FNumber", ["FBaseUnitQty<>0", ...movementFilters], pageSize), sources.inboundSource.fields);
    const transferFilters = [...movementFilters];
    const transferRows = rowsToObjects(await this.queryByTransferBatches(identity, sources.transferSource, relatedCodes, relatedCodes, transferFilters, pageSize), sources.transferSource.fields);
    const sourceBillNumbers = [...new Set(transferRows.map((row) => String(row["源单编号"] || "").trim()).filter(Boolean))];
    const signoffMaterialFilters = [];
    if (args.materialNumber) signoffMaterialFilters.push(`FMaterialID.FNumber='${escapeValue(args.materialNumber)}'`);
    if (args.materialName) signoffMaterialFilters.push(`FMaterialID.FName LIKE '%${escapeValue(args.materialName)}%'`);
    const signoffRows = rowsToObjects(await this.queryByBillBatches(identity, sources.signoffSource, sourceBillNumbers, ["FDate<'" + nextDay(asOfDate) + "'", "FDocumentStatus='C'", "FCancelStatus='A'", ...signoffMaterialFilters, ...(args.subprojectNumber ? [`F_PARA_SaleSubProId.FNumber LIKE '%${escapeValue(args.subprojectNumber)}%'`] : [])], pageSize), sources.signoffSource.fields);
    return buildInventoryCycleResult({ warehouseRows, inventoryRows: currentRows, inboundRows, transferRows, signoffRows, asOfDate, args, limit });
  }

  matchesInventoryWarehouse(row, args) {
    const stage = warehouseStage(row["仓库名称"]);
    const scope = String(args.warehouseScope || "all");
    if (!["公司仓", "项目仓", "客户仓"].includes(stage)) return false;
    if ((stage === "项目仓" || stage === "客户仓")
      && !String(row["销售项目编码"] || "").trim()
      && !String(row["销售子项目编码"] || "").trim()) return false;
    if (scope === "project" && stage !== "项目仓") return false;
    if (scope === "customer" && stage !== "客户仓") return false;
    if (scope === "company" && stage !== "公司仓") return false;
    if (args.warehouseName && !String(row["仓库名称"] || "").includes(String(args.warehouseName).trim())) return false;
    if (args.subprojectNumber) {
      const needle = String(args.subprojectNumber).trim().toUpperCase();
      const number = String(row["销售子项目编码"] || "").toUpperCase();
      const name = String(row["销售子项目名称"] || "").toUpperCase();
      if (!number.includes(needle) && !name.includes(needle)) return false;
    }
    return true;
  }

  async queryByCodeBatches(identity, source, codes, field, extraFilter, pageSize) {
    if (!codes.length) return [];
    const rows = [];
    for (const batch of chunkValues(codes, 120)) {
      rows.push(...await this.queryAllPages(identity, {
        FormId: source.formId,
        FieldKeys: source.fields.map(([key]) => key).join(","),
        FilterString: [...extraFilter, buildInFilter(field, batch)].join(" AND "),
        OrderString: source.defaultOrder || "FDate ASC,FBillNo ASC",
        TopRowCount: 0,
      }, pageSize));
    }
    return rows;
  }

  async queryByTransferBatches(identity, source, sourceCodes, destinationCodes, extraFilter, pageSize) {
    if (!sourceCodes.length || !destinationCodes.length) return [];
    const rows = [];
    for (const sourceBatch of chunkValues(sourceCodes, 100)) {
      const filter = [
        ...extraFilter,
        buildInFilter("FSrcStockId.FNumber", sourceBatch),
        buildInFilter("FDestStockId.FNumber", destinationCodes),
      ].join(" AND ");
      rows.push(...await this.queryAllPages(identity, {
        FormId: source.formId,
        FieldKeys: source.fields.map(([key]) => key).join(","),
        FilterString: filter,
        OrderString: source.defaultOrder || "FDate ASC,FBillNo ASC",
        TopRowCount: 0,
      }, pageSize));
    }
    return rows;
  }

  async queryByBillBatches(identity, source, billNumbers, extraFilter, pageSize) {
    if (!billNumbers.length) return [];
    const rows = [];
    for (const batch of chunkValues(billNumbers, 150)) {
      rows.push(...await this.queryAllPages(identity, {
        FormId: source.formId,
        FieldKeys: source.fields.map(([key]) => key).join(","),
        FilterString: [...extraFilter, buildInFilter("FSrcBillNo", batch)].join(" AND "),
        OrderString: source.defaultOrder || "FDate ASC,FBillNo ASC",
        TopRowCount: 0,
      }, pageSize));
    }
    return rows;
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
        FilterString: buildSubprojectBatchFilter(batch, extraFilter, source.subprojectFilterField),
        OrderString: source.defaultOrder || "FDATE ASC,FBillNo ASC",
        TopRowCount: 0,
      }, pageSize));
    }
    return { rows };
  }

  async queryByBillNumbers(identity, source, billNumbers, pageSize) {
    if (!billNumbers.length) return { rows: [] };
    const rows = [];
    for (const batch of chunkValues(billNumbers, 150)) {
      rows.push(...await this.queryAllPages(identity, {
        FormId: source.formId,
        FieldKeys: source.fields.map(([key]) => key).join(","),
        FilterString: buildBillBatchFilter(batch),
        OrderString: source.defaultOrder || "FSRCBILLNO ASC",
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
    const limit = normalizeLimit(args.limit, this.config.kingdee.maxRows);
    const filters = [
      `FOriginatorId.FUserAccount='${escapeValue(identity.kingdeeUsername)}'`,
      "FStatus='2'",
    ];
    if (billNumber) filters.push(`FNumber LIKE '${escapeValue(billNumber)}%'`);
    const rawRows = await this.kingdee.executeBillQuery(identity.kingdeeUsername, {
      FormId: "WF_ProcInstBill",
      FieldKeys: workflowFieldKeys.join(","),
      FilterString: filters.join(" AND "),
      OrderString: "FCreateTime DESC",
      TopRowCount: 0,
      StartRow: 0,
      Limit: limit + 1,
    });
    const truncated = rawRows.length > limit;
    const rows = workflowRows(rawRows.slice(0, limit));
    const query = { scope: "mine", status: "审批中", ...(billNumber ? { billNumber } : {}) };
    return {
      tool: "workflow_progress",
      label: "我发起的流程",
      query,
      columns: workflowColumns,
      rows,
      count: rows.length,
      truncated,
      summary: rows.length ? `找到 ${rows.length}${truncated ? " 条以上" : " 条"}我发起且正在审批的流程。` : "没有找到正在审批的流程。",
    };
  }
}

function aggregateInvoiceWriteoffRisk(invoiceRows, agingInvoiceRows, sourceRows, invoiceWriteoffRows, receiptWriteoffRows, cutoffDate) {
  const candidateNumbers = new Set(agingInvoiceRows.map((row) => String(row["销售发票号"] || "").trim()).filter(Boolean));
  const invoices = new Map();
  for (const row of invoiceRows) {
    const invoiceNumber = String(row["销售发票号"] || "").trim();
    if (!invoiceNumber) continue;
    let invoice = invoices.get(invoiceNumber);
    if (!invoice) {
      invoice = {
        invoiceNumber,
        code: String(row["销售子项目编码"] || "").trim(),
        name: row["销售子项目名称"],
        customer: row["客户"],
        date: "",
        amount: 0,
      };
      invoices.set(invoiceNumber, invoice);
    }
    const invoiceDate = String(row["开票日期"] || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) && (!invoice.date || invoiceDate < invoice.date)) invoice.date = invoiceDate;
    const amount = signedInvoiceAmount(row);
    invoice.amount += amount;
  }

  const arDetails = new Map();
  const arBills = new Map();
  for (const row of sourceRows) {
    const billNo = String(row["应收单号"] || "").trim();
    if (!billNo) continue;
    const detailId = String(row["应收分录内码"] || "").trim();
    const invoiceAmount = Math.max(0, Number(row["已开票金额"]) || 0);
    const receivedAmount = Math.max(0, Number(row["已收金额"]) || 0);
    const outstanding = Math.min(Math.max(0, Number(row["未收金额"]) || 0), Math.max(0, invoiceAmount - receivedAmount));
    const record = { amount: invoiceAmount, outstanding };
    if (detailId) {
      const key = `${billNo}|${detailId}`;
      const existing = arDetails.get(key);
      if (existing) {
        existing.amount = Math.max(existing.amount, record.amount);
        existing.outstanding = Math.max(existing.outstanding, record.outstanding);
      } else arDetails.set(key, record);
    }
    const bill = arBills.get(billNo) || { amount: 0, outstanding: 0 };
    bill.amount += invoiceAmount;
    bill.outstanding += outstanding;
    arBills.set(billNo, bill);
  }

  const receiptWriteoffsByBill = new Map();
  for (const row of receiptWriteoffRows) {
    const sourceType = String(row["来源单据类型"] || "").trim();
    const targetType = String(row["目标单据类型"] || "").trim();
    if (sourceType !== "AR_receivable" || !["AR_RECEIVEBILL", "AR_REFUNDBILL"].includes(targetType)) continue;
    const billNo = String(row["来源单据号"] || "").trim();
    if (!billNo) continue;
    const residual = Number(row["未收款核销金额"]);
    const list = receiptWriteoffsByBill.get(billNo) || [];
    list.push({ residual: Number.isFinite(residual) ? Math.max(0, residual) : null });
    receiptWriteoffsByBill.set(billNo, list);
  }

  const relationRows = invoiceWriteoffRows
    .filter((row) => row["来源单据类型"] === "IV_SALESIC" && row["目标单据类型"] === "AR_receivable")
    .map((row) => {
      const currentAmount = Number(row["本次开票核销金额"]);
      const cumulativeAmount = Number(row["累计开票核销金额"]);
      // Keep red-invoice reversal amounts. Dropping negative matching records
      // makes the invoice-to-receivable link gross while invoice totals are
      // net of red and blue invoices.
      const amount = Number.isFinite(currentAmount) && Math.abs(currentAmount) > 0.004
        ? currentAmount
        : (Number.isFinite(cumulativeAmount) ? cumulativeAmount : 0);
      return {
        invoiceNumber: String(row["来源单据号"] || "").trim(),
        invoiceEntryId: String(row["来源分录内码"] || "").trim(),
        billNo: String(row["目标单据号"] || "").trim(),
        detailId: String(row["目标分录内码"] || "").trim(),
        amount,
      };
    })
    .filter((row) => row.invoiceNumber && Math.abs(row.amount) > 0.004);
  const relationsByInvoice = new Map();
  for (const relation of relationRows) {
    const list = relationsByInvoice.get(relation.invoiceNumber) || [];
    list.push(relation);
    relationsByInvoice.set(relation.invoiceNumber, list);
  }
  const relationsByTarget = new Map();
  for (const relation of relationRows) {
    const key = `${relation.billNo}|${relation.detailId}`;
    const list = relationsByTarget.get(key) || [];
    list.push(relation);
    relationsByTarget.set(key, list);
  }
  const unpaidByInvoice = new Map();
  for (const [targetKey, relations] of relationsByTarget) {
    const [billNo] = targetKey.split("|");
    const detail = arDetails.get(targetKey);
    const bill = arBills.get(billNo) || { amount: 0, outstanding: 0 };
    const totalLinked = relations.reduce((total, relation) => total + relation.amount, 0);
    const denominator = Math.max(totalLinked, detail?.amount || bill.amount);
    const billWriteoffs = receiptWriteoffsByBill.get(billNo) || [];
    const knownBillResiduals = billWriteoffs.map((row) => row.residual).filter((value) => value != null);
    const billResidual = knownBillResiduals.length ? Math.min(...knownBillResiduals) : null;
    const detailShare = bill.amount > 0 ? (billResidual == null ? bill.outstanding : billResidual) * ((detail?.amount || totalLinked) / bill.amount) : (billResidual || 0);
    const outstanding = detail
      ? Math.min(detail.outstanding, Math.max(0, detailShare))
      : Math.max(0, detailShare);
    if (denominator <= 0 || outstanding <= 0) continue;
    for (const relation of relations) {
      const unpaid = relation.amount * outstanding / denominator;
      unpaidByInvoice.set(relation.invoiceNumber, (unpaidByInvoice.get(relation.invoiceNumber) || 0) + unpaid);
    }
  }

  // Net red/blue invoices and their invoice-to-receivable links at the
  // subproject level. A red invoice can reverse an earlier blue invoice with
  // a different invoice number, so calculating `max(invoice - link, 0)` per
  // invoice would double-count the reversed blue invoice.
  const effectiveBySubproject = new Map();
  for (const invoice of invoices.values()) {
    if (!candidateNumbers.has(invoice.invoiceNumber) || !invoice.date || (cutoffDate && invoice.date >= cutoffDate)) continue;
    const linkedAmount = (relationsByInvoice.get(invoice.invoiceNumber) || [])
      .reduce((total, relation) => total + relation.amount, 0);
    const outstandingAmount = Math.max(0, unpaidByInvoice.get(invoice.invoiceNumber) || 0);
    const key = normalizeSubprojectKey(invoice.code);
    const aggregate = effectiveBySubproject.get(key) || {
      code: invoice.code,
      name: invoice.name,
      customer: invoice.customer,
      date: invoice.date,
      invoiceAmount: 0,
      linkedAmount: 0,
      outstandingAmount: 0,
    };
    aggregate.invoiceAmount += invoice.amount;
    aggregate.linkedAmount += linkedAmount;
    aggregate.outstandingAmount += outstandingAmount;
    if (invoice.date < aggregate.date) aggregate.date = invoice.date;
    effectiveBySubproject.set(key, aggregate);
  }

  const result = new Map();
  for (const [key, aggregate] of effectiveBySubproject) {
    const unreceiptedAmount = Math.max(0, aggregate.invoiceAmount - aggregate.linkedAmount);
    if (unreceiptedAmount <= 0.004 && aggregate.outstandingAmount <= 0.004) continue;
    result.set(key, [{
      code: aggregate.code,
      name: aggregate.name,
      customer: aggregate.customer,
      date: aggregate.date,
      unreceiptedAmount,
      outstandingAmount: aggregate.outstandingAmount,
    }]);
  }
  return result;
}

function aggregateReceivableAging(sourceRows, { invoiceWriteoffRows = [], paymentConditionRows = [], asOfDate, minimumDays, partial = false }) {
  const cutoffDate = asOfDate && Number.isInteger(minimumDays) ? shiftDate(asOfDate, -minimumDays) : "";
  const linksByDetail = new Map();
  const linksByBill = new Map();
  for (const row of invoiceWriteoffRows) {
    if (row["来源单据类型"] !== "IV_SALESIC" || row["目标单据类型"] !== "AR_receivable") continue;
    const billNo = String(row["目标单据号"] || "").trim();
    if (!billNo) continue;
    const currentAmount = Number(row["本次开票核销金额"]);
    const cumulativeAmount = Number(row["累计开票核销金额"]);
    const amount = Number.isFinite(currentAmount) && Math.abs(currentAmount) > 0.004
      ? currentAmount
      : (Number.isFinite(cumulativeAmount) ? cumulativeAmount : 0);
    if (Math.abs(amount) <= 0.004) continue;
    const detailId = String(row["目标分录内码"] || "").trim();
    const detailKey = `${billNo}|${detailId}`;
    linksByDetail.set(detailKey, [...(linksByDetail.get(detailKey) || []), amount]);
    linksByBill.set(billNo, [...(linksByBill.get(billNo) || []), amount]);
  }

  const details = new Map();
  let rowsWithoutSubproject = 0;
  let rowsWithoutDate = 0;
  for (const row of sourceRows) {
    const billNo = String(row["应收单号"] || "").trim();
    if (!billNo) continue;
    const code = String(row["销售子项目编码"] || "").trim();
    if (!code) { rowsWithoutSubproject += 1; continue; }
    const date = String(row["应收日期"] || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { rowsWithoutDate += 1; continue; }
    if (cutoffDate && date >= cutoffDate) continue;
    const receivedValue = Number(row["已收金额"]);
    const outstandingValue = Number(row["未收金额"]);
    const fallbackTotal = Number(row["应收单总额"]);
    const total = Number.isFinite(receivedValue) && Number.isFinite(outstandingValue)
      ? Math.max(0, receivedValue + outstandingValue)
      : Math.max(0, fallbackTotal || 0);
    const outstanding = Math.min(total, Math.max(0, Number.isFinite(outstandingValue) ? outstandingValue : 0));
    if (total <= 0.004 || outstanding <= 0.004) continue;
    const detailId = String(row["应收分录内码"] || "").trim();
    const key = `${billNo}|${detailId}`;
    const existing = details.get(key);
    if (existing) {
      existing.total = Math.max(existing.total, total);
      existing.outstanding = Math.max(existing.outstanding, outstanding);
      if (date < existing.date) existing.date = date;
      continue;
    }
    details.set(key, { billNo, detailId, code, name: row["销售子项目名称"], customer: row["客户"], date, total, outstanding });
  }

  const subprojects = new Map();
  for (const detail of details.values()) {
    const key = normalizeSubprojectKey(detail.code);
    const subproject = subprojects.get(key) || {
      code: detail.code,
      names: new Set(),
      customers: new Set(),
      paymentConditions: new Set(),
      billNumbers: new Set(),
      firstDate: detail.date,
      receivableAmount: 0,
      receivedAmount: 0,
      outstandingAmount: 0,
      unbilledAmount: 0,
    };
    addIfPresent(subproject.names, detail.name);
    addIfPresent(subproject.customers, detail.customer);
    subproject.billNumbers.add(detail.billNo);
    if (detail.date < subproject.firstDate) subproject.firstDate = detail.date;
    const linkedRows = linksByDetail.get(`${detail.billNo}|${detail.detailId}`)
      || (detail.detailId ? [] : (linksByBill.get(detail.billNo) || []));
    const linkedAmount = linkedRows.reduce((total, amount) => total + amount, 0);
    const receivedAmount = Math.max(0, detail.total - detail.outstanding);
    const unbilledAmount = Math.min(detail.total, Math.max(0, detail.total - linkedAmount));
    subproject.receivableAmount += detail.total;
    subproject.receivedAmount += receivedAmount;
    subproject.outstandingAmount += detail.outstanding;
    subproject.unbilledAmount += unbilledAmount;
    subprojects.set(key, subproject);
  }

  for (const row of paymentConditionRows) {
    const key = normalizeSubprojectKey(row["销售子项目编码"]);
    const subproject = subprojects.get(key);
    if (subproject) addIfPresent(subproject.paymentConditions, row["收款条件"]);
  }

  const rows = [...subprojects.values()].map((subproject) => {
    if (!subproject.firstDate || subproject.outstandingAmount <= 0.004) return null;
    const receivedAmount = roundMoney(subproject.receivedAmount);
    const outstandingAmount = roundMoney(subproject.outstandingAmount);
    return {
      客户: joinValues(subproject.customers),
      销售子项目编码: subproject.code,
      销售子项目名称: joinValues(subproject.names),
      应收账龄日期: subproject.firstDate,
      应收超期天数: elapsedDays(subproject.firstDate, asOfDate),
      应收单数: subproject.billNumbers.size,
      应收金额: roundMoney(subproject.receivableAmount),
      应收已收款金额: receivedAmount,
      应收未收款金额: outstandingAmount,
      应收未开票金额: roundMoney(subproject.unbilledAmount),
      回款状态: receivedAmount > 0.004 ? "部分回款未结清" : "完全未回款",
      收款条件: joinValues(subproject.paymentConditions),
    };
  }).filter(Boolean).sort((left, right) => right["应收未收款金额"] - left["应收未收款金额"] || right["应收未开票金额"] - left["应收未开票金额"] || right["应收超期天数"] - left["应收超期天数"]);

  const fullyUnpaid = rows.filter((row) => row["应收已收款金额"] <= 0.004);
  const partiallyPaid = rows.filter((row) => row["应收已收款金额"] > 0.004);
  const unbilled = rows.filter((row) => row["应收未开票金额"] > 0.004);
  const outstandingAmount = sumMoney(rows, "应收未收款金额");
  const statistics = {
    asOfDate,
    minimumDays,
    subprojectCount: rows.length,
    receivableBillCount: rows.reduce((total, row) => total + row["应收单数"], 0),
    customerCount: new Set(rows.map((row) => row["客户"]).filter(Boolean)).size,
    receivableAmount: sumMoney(rows, "应收金额"),
    receivedAmount: sumMoney(rows, "应收已收款金额"),
    outstandingAmount,
    unbilledAmount: sumMoney(rows, "应收未开票金额"),
    fullyUnpaidCount: fullyUnpaid.length,
    fullyUnpaidAmount: sumMoney(fullyUnpaid, "应收未收款金额"),
    partiallyPaidCount: partiallyPaid.length,
    partiallyPaidAmount: sumMoney(partiallyPaid, "应收未收款金额"),
    unbilledCount: unbilled.length,
    oldestDays: rows.reduce((maximum, row) => Math.max(maximum, row["应收超期天数"]), 0),
    missingReceivableDateRows: rowsWithoutDate,
    rowsWithoutSubproject,
    partial,
  };
  const format = (value) => new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const exclusions = [
    rowsWithoutDate ? `${rowsWithoutDate} 条明细缺少应收日期` : "",
    rowsWithoutSubproject ? `${rowsWithoutSubproject} 条明细缺少销售子项目编码` : "",
  ].filter(Boolean);
  const summary = rows.length
    ? `截至 ${asOfDate}，共 ${rows.length} 个销售子项目以最早未收款应收单日期起算超过 ${minimumDays} 天，应收未收款金额 ¥${format(outstandingAmount)}，其中应收未开票金额 ¥${format(statistics.unbilledAmount)}${partial ? "（已达到扫描上限，结果可能不完整）" : ""}${exclusions.length ? `；另有${exclusions.join("、")}未纳入` : ""}。`
    : `截至 ${asOfDate}，没有找到以应收单日期起算超过 ${minimumDays} 天且仍有未收款余额的销售子项目${exclusions.length ? `；${exclusions.join("、")}未纳入` : ""}。`;
  return { rows, statistics, summary };
}

function aggregateOverdueRiskCombined(invoiceResult, receivableResult, { invoiceDays, receivableDays }) {
  const invoiceRows = new Map(invoiceResult.rows.map((row) => [normalizeSubprojectKey(row["销售子项目编码"]), row]));
  const receivableRows = new Map(receivableResult.rows.map((row) => [normalizeSubprojectKey(row["销售子项目编码"]), row]));
  const keys = new Set([...invoiceRows.keys(), ...receivableRows.keys()]);
  const rows = [...keys].map((key) => {
    const invoice = invoiceRows.get(key);
    const receivable = receivableRows.get(key);
    const invoiceAmount = Math.max(0, Number(invoice?.["未回款金额"]) || 0);
    const receivableAmount = Math.max(0, Number(receivable?.["应收未收款金额"]) || 0);
    if (invoiceAmount <= 0.004 && receivableAmount <= 0.004) return null;
    const useInvoice = invoiceAmount > receivableAmount;
    const selected = useInvoice ? invoice : receivable;
    return {
      客户: selected?.["客户"] || invoice?.["客户"] || receivable?.["客户"] || "",
      销售子项目编码: selected?.["销售子项目编码"] || invoice?.["销售子项目编码"] || receivable?.["销售子项目编码"] || "",
      销售子项目名称: selected?.["销售子项目名称"] || invoice?.["销售子项目名称"] || receivable?.["销售子项目名称"] || "",
      开票未回款金额: roundMoney(invoiceAmount),
      应收未收款金额: roundMoney(receivableAmount),
      金额差异: roundMoney(invoiceAmount - receivableAmount),
      最终超期风险金额: roundMoney(Math.max(invoiceAmount, receivableAmount)),
      采用口径: useInvoice ? "发票超期" : "应收超期",
      账龄日期: selected?.[useInvoice ? "开票日期" : "应收账龄日期"] || "",
      超期天数: selected?.[useInvoice ? "超期天数" : "应收超期天数"] || 0,
      超期阈值: useInvoice ? invoiceDays : receivableDays,
      超期发票数: invoice?.["超期发票数"] || 0,
      超期应收单数: receivable?.["应收单数"] || 0,
      应收未开票金额: roundMoney(Number(receivable?.["应收未开票金额"]) || 0),
      未生成应收金额: roundMoney(Number(invoice?.["未生成应收金额"]) || 0),
      回款状态: selected?.["回款状态"] || "",
      收款条件: selected?.["收款条件"] || invoice?.["收款条件"] || receivable?.["收款条件"] || "",
    };
  }).filter(Boolean).sort((left, right) => right["最终超期风险金额"] - left["最终超期风险金额"] || right["超期天数"] - left["超期天数"]);

  const invoiceSelected = rows.filter((row) => row["采用口径"] === "发票超期");
  const receivableSelected = rows.filter((row) => row["采用口径"] === "应收超期");
  const finalRiskAmount = sumMoney(rows, "最终超期风险金额");
  const statistics = {
    asOfDate: invoiceResult.query.asOfDate,
    invoiceDays,
    receivableDays,
    subprojectCount: rows.length,
    customerCount: new Set(rows.map((row) => row["客户"]).filter(Boolean)).size,
    invoiceRiskAmount: sumMoney(rows, "开票未回款金额"),
    receivableRiskAmount: sumMoney(rows, "应收未收款金额"),
    finalRiskAmount,
    invoiceSelectedCount: invoiceSelected.length,
    invoiceSelectedAmount: sumMoney(invoiceSelected, "最终超期风险金额"),
    receivableSelectedCount: receivableSelected.length,
    receivableSelectedAmount: sumMoney(receivableSelected, "最终超期风险金额"),
    partial: Boolean(invoiceResult.truncated || receivableResult.truncated),
  };
  const format = (value) => new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const summary = rows.length
    ? `截至 ${statistics.asOfDate}，按发票超过 ${invoiceDays} 天和应收超过 ${receivableDays} 天比较，共 ${rows.length} 个销售子项目，最终超期风险金额 ¥${format(finalRiskAmount)}；其中 ${invoiceSelected.length} 个采用发票口径，${receivableSelected.length} 个采用应收口径${statistics.partial ? "（扫描结果可能不完整）" : ""}。`
    : `截至 ${statistics.asOfDate}，没有找到按发票超过 ${invoiceDays} 天或应收超过 ${receivableDays} 天仍有未回款余额的销售子项目。`;
  return { rows, statistics, summary };
}

function aggregateOverdueReceivables(sourceRows, { invoiceRows = [], overdueInvoiceRows = [], invoiceWriteoffRows = null, receiptWriteoffRows = [], receiptRows = [], refundRows = [], paymentConditionRows = [], asOfDate, minimumDays, partial = false }) {
  const strictInvoiceMatching = Array.isArray(invoiceWriteoffRows);
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
  const strictRiskBySubproject = strictInvoiceMatching
    ? aggregateInvoiceWriteoffRisk(invoiceRows, agingInvoiceRows, sourceRows, invoiceWriteoffRows, receiptWriteoffRows, cutoffDate)
    : new Map();
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
        overdueInvoiceAmount: 0,
        invoiceAmount: 0,
        receivableAmount: 0,
        outstandingAmount: 0,
        writtenOffAmount: 0,
        actualReceiptAmount: 0,
        refundAmount: 0,
        writtenOffBills: new Set(),
        writtenOffKnown: false,
        hasValidAgingCandidate: false,
        strictOutstandingAmount: 0,
        strictUnreceiptedAmount: 0,
      };
      subprojects.set(key, subproject);
    }
    return subproject;
  };

  if (strictInvoiceMatching) {
    for (const risks of strictRiskBySubproject.values()) {
      for (const risk of risks) {
        const subproject = getSubproject(risk, risk.code);
        if (!subproject) continue;
        subproject.strictOutstandingAmount += risk.outstandingAmount;
        subproject.strictUnreceiptedAmount += risk.unreceiptedAmount;
      }
    }
  }

  // Every public amount in this report must use the same overdue-invoice
  // scope. Do not let a future/non-overdue invoice change the totals for a
  // subproject that has an overdue invoice.
  for (const row of agingInvoiceRows) {
    const subproject = getSubproject(row);
    if (!subproject) continue;
    addIfPresent(subproject.names, row["销售子项目名称"]);
    addIfPresent(subproject.customers, row["客户"]);
    addIfPresent(subproject.overdueInvoiceNumbers, row["销售发票号"]);
    subproject.overdueInvoiceAmount += signedInvoiceAmount(row);
    const invoiceDate = String(row["开票日期"] || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
      subproject.hasValidAgingCandidate = true;
      if (!subproject.firstOverdueInvoiceDate || invoiceDate < subproject.firstOverdueInvoiceDate) subproject.firstOverdueInvoiceDate = invoiceDate;
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
    if (!subproject.firstOverdueInvoiceDate) {
      // In strict invoice matching mode a valid old invoice that is already
      // fully formed and fully written off is intentionally omitted, rather
      // than reported as a missing-date subproject.
      if (!strictInvoiceMatching || !subproject.hasValidAgingCandidate) missingInvoiceDateSubprojects += 1;
      return null;
    }
    const firstDate = subproject.firstOverdueInvoiceDate;
    const invoiceAmount = roundMoney(strictInvoiceMatching
      ? subproject.overdueInvoiceAmount
      : (subproject.invoiceNumbers.size ? subproject.invoiceAmount : subproject.receivableAmount));
    const outstandingAmount = roundMoney(strictInvoiceMatching ? subproject.strictOutstandingAmount : subproject.outstandingAmount);
    const unreceiptedInvoiceAmount = roundMoney(strictInvoiceMatching
      ? subproject.strictUnreceiptedAmount
      : Math.max(0, invoiceAmount - subproject.receivableAmount));
    // In strict mode the amount is allocated to the overdue invoice scope
    // from invoice-to-receivable matching. This keeps all displayed amounts
    // on one aging basis and avoids including receipts for future invoices.
    const receivedAmount = roundMoney(strictInvoiceMatching
      ? Math.max(0, invoiceAmount - outstandingAmount - unreceiptedInvoiceAmount)
      : subproject.actualReceiptAmount - subproject.refundAmount);
    const unpaidAmount = roundMoney(Math.max(0, invoiceAmount - receivedAmount));
    const fallbackWrittenOff = Math.max(0, subproject.receivableAmount - outstandingAmount);
    const writtenOffAmount = strictInvoiceMatching
      ? receivedAmount
      : roundMoney(subproject.writtenOffKnown ? subproject.writtenOffAmount : fallbackWrittenOff);
    const unreconciledAmount = roundMoney(Math.max(0, receivedAmount - writtenOffAmount));
    const hasRisk = outstandingAmount > 0.004 || unreceiptedInvoiceAmount > 0.004;
    if (!hasRisk) return null;
    let status = "完全未回款";
    if (unreceiptedInvoiceAmount > 0.004) {
      status = invoiceAmount - unreceiptedInvoiceAmount > 0.004 ? "未完全形成应收" : "完全未形成应收";
    }
    else if (outstandingAmount <= 0.004) status = "已结清";
    else if (receivedAmount > 0.004 || writtenOffAmount > 0.004) status = "部分回款未结清";
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
      已收款金额: receivedAmount,
      收款未核销金额: unreconciledAmount,
      未生成应收金额: unreceiptedInvoiceAmount,
      应收未收款金额: outstandingAmount,
      未回款金额: unpaidAmount,
      回款状态: status,
    };
  }).filter(Boolean).sort((left, right) => right["未回款金额"] - left["未回款金额"] || right["未生成应收金额"] - left["未生成应收金额"] || right["超期天数"] - left["超期天数"]);

  const completelyUnpaid = rows.filter((row) => row["回款状态"] === "完全未回款");
  const partiallyPaid = rows.filter((row) => row["回款状态"] === "部分回款未结清");
  const unreceipted = rows.filter((row) => row["未生成应收金额"] > 0.004);
  const fullyUnreceipted = rows.filter((row) => row["回款状态"] === "完全未形成应收");
  const partiallyUnreceipted = rows.filter((row) => row["回款状态"] === "未完全形成应收");
  const receivableOutstandingAmount = sumMoney(rows, "应收未收款金额");
  const receivedAmount = sumMoney(rows, "已收款金额");
  const paymentUnreconciledAmount = sumMoney(rows, "收款未核销金额");
  const unpaidAmount = sumMoney(rows, "未回款金额");
  const unreceiptedInvoiceAmount = sumMoney(rows, "未生成应收金额");
  const customerCount = new Set(rows.map((row) => row["客户"]).filter(Boolean)).size;
  const statistics = {
    asOfDate,
    minimumDays,
    subprojectCount: rows.length,
    invoiceCount: rows.reduce((total, row) => total + row["超期发票数"], 0),
    receivableBillCount: rows.reduce((total, row) => total + row["应收单数"], 0),
    customerCount,
    unpaidAmount,
    receivableOutstandingAmount,
    receivedAmount,
    paymentUnreconciledAmount,
    unreceiptedInvoiceAmount,
    completelyUnpaidCount: completelyUnpaid.length,
    completelyUnpaidAmount: sumMoney(completelyUnpaid, "应收未收款金额"),
    partiallyPaidCount: partiallyPaid.length,
    partiallyPaidAmount: sumMoney(partiallyPaid, "应收未收款金额"),
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
    // Deprecated aliases retained for existing API consumers. New clients
    // should use unpaidAmount, receivableOutstandingAmount, receivedAmount,
    // and paymentUnreconciledAmount.
    outstandingAmount: receivableOutstandingAmount,
    actualReceiptAmount: receivedAmount,
    unreconciledAmount: paymentUnreconciledAmount,
  };
  const amount = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(unpaidAmount);
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
  buildReceivableAgingCandidateFilter,
  buildOverdueInvoiceCandidateFilter,
  buildOverdueInvoiceFilter,
  aggregateReceivableAging,
  aggregateOverdueRiskCombined,
  aggregateOverdueReceivables,
  personnelCostDateRange,
  buildPersonnelCostFilters,
  aggregatePersonnelCost,
  mapExpenseDetailRows,
  workflowRows,
};
