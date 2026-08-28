/**
 * Sales sub-project business analysis.
 *
 * The query engine deliberately keeps the Kingdee field mapping in the
 * catalog and keeps all cross-document arithmetic here.  This makes the
 * accounting/fulfilment rules unit-testable without requiring a live Kingdee
 * session and, importantly, keeps expected margin rate as a header value
 * instead of accidentally summing percentages.
 */

function dateString(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseDate(value) {
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function isoDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`日期格式应为 YYYY-MM-DD：${text}`);
  return text;
}

function elapsedDays(from, to) {
  const start = Date.parse(`${parseDate(from)}T00:00:00Z`);
  const end = Date.parse(`${parseDate(to)}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.floor((end - start) / 86400000) : 0;
}

function nextDay(value) {
  const date = new Date(`${isoDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function salesBusinessDateRange(args = {}, now = new Date(), maximumDays = 366) {
  const today = dateString(now);
  const dateFrom = isoDate(args.dateFrom || `${today.slice(0, 4)}-01-01`);
  const dateTo = isoDate(args.dateTo || today);
  if (dateFrom > dateTo) throw Object.assign(new Error("开始日期不能晚于结束日期。"), { statusCode: 400 });
  const days = elapsedDays(dateFrom, dateTo) + 1;
  if (days > maximumDays) throw Object.assign(new Error(`销售经营分析查询范围最多为 ${maximumDays} 天。`), { statusCode: 400 });
  return { dateFrom, dateTo, dateToExclusive: nextDay(dateTo), days };
}

function escapeValue(value) {
  return String(value).replaceAll("'", "''").replace(/[\u0000-\u001f]/g, "");
}

function buildSalesBusinessSourceFilter(source, args = {}, range, { includeSubproject = true } = {}) {
  const clauses = [source.filter].filter(Boolean);
  if (source.dateField) clauses.push(`${source.dateField}>='${range.dateFrom}'`, `${source.dateField}<'${range.dateToExclusive}'`);
  if (args.billNumber && source.billField) clauses.push(`${source.billField}='${escapeValue(args.billNumber)}'`);
  if (args.customerName && source.customerField) clauses.push(`${source.customerField} LIKE '%${escapeValue(args.customerName)}%'`);
  if (args.organizationName && source.organizationField) clauses.push(`${source.organizationField} LIKE '%${escapeValue(args.organizationName)}%'`);
  if (args.salespersonName && source.salespersonField) clauses.push(`${source.salespersonField} LIKE '%${escapeValue(args.salespersonName)}%'`);
  if (includeSubproject && args.subprojectNumber && source.subprojectField) clauses.push(`${source.subprojectField} LIKE '%${escapeValue(args.subprojectNumber)}%'`);
  if (args.projectNumber && source.projectField) clauses.push(`${source.projectField} LIKE '%${escapeValue(args.projectNumber)}%'`);
  return clauses.join(" AND ");
}

function text(value) {
  return String(value == null ? "" : value).normalize("NFKC").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(row, keys) {
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

function key(value) {
  return text(value).toUpperCase();
}

function add(set, value) {
  const clean = text(value);
  if (clean) set.add(clean);
}

function join(set) {
  return [...set].join("、");
}

function signedInvoiceAmount(row) {
  const amount = number(row["发票金额"]);
  const marker = text(row["红蓝字标识"]).toLowerCase();
  const red = marker === "1" || marker === "red" || marker === "r" || marker.includes("红");
  return red && amount > 0 ? -amount : amount;
}

function ensureSubproject(map, code, base = {}) {
  const cleanCode = text(code);
  if (!cleanCode) return null;
  const normalized = key(cleanCode);
  let item = map.get(normalized);
  if (!item) {
    item = {
      code: cleanCode,
      names: new Set(),
      projectCodes: new Set(),
      projectNames: new Set(),
      contractCodes: new Set(),
      contractNames: new Set(),
      customerCodes: new Set(),
      customers: new Set(),
      customerManagers: new Set(),
      projectManagers: new Set(),
      salespersons: new Set(),
      salesOrganizations: new Set(),
      businessDate: "",
      documentStatus: "",
      projectStatus: "",
      contractAmount: 0,
      noTaxContractAmount: 0,
      expectedGrossProfit: 0,
      expectedGrossMarginRate: null,
      expectedMarginSource: "field",
      beginInvoiceAmount: 0,
      beginReceiveAmount: 0,
      paymentConditions: new Set(),
      projectAddress: new Set(),
      projectTypes: new Set(),
      contractNumbers: new Set(),
      orderNumbers: new Set(),
      orderRows: [],
      outboundNumbers: new Set(),
      outboundRows: [],
      invoiceNumbers: new Set(),
      invoiceRows: [],
      receivableNumbers: new Set(),
      receivableRows: [],
      receiptNumbers: new Set(),
      receiptRows: [],
      refundNumbers: new Set(),
      refundRows: [],
      orderAmount: 0,
      orderNoTaxAmount: 0,
      orderedQty: 0,
      shippedQty: 0,
      returnQty: 0,
      remainingQty: 0,
      hasRemainingQty: false,
      outboundQty: 0,
      signedQty: 0,
      outboundAmount: 0,
      invoiceAmount: 0,
      receivableAmount: 0,
      receivableReceivedAmount: 0,
      receivableOutstandingAmount: 0,
      receiptAmount: 0,
      refundAmount: 0,
      sourceGaps: new Set(),
    };
    map.set(normalized, item);
  }
  if (base) {
    add(item.names, base["销售子项目名称"]);
    add(item.projectCodes, base["销售项目编码"]);
    add(item.projectNames, base["销售项目名称"]);
    add(item.contractCodes, base["销售合同编码"]);
    add(item.contractNames, base["销售合同名称"]);
    add(item.customerCodes, base["客户编码"]);
    add(item.customers, base["客户"]);
    add(item.customerManagers, base["客户经理"]);
    add(item.projectManagers, base["项目经理"]);
    add(item.paymentConditions, base["收款条件"]);
    add(item.projectAddress, base["项目地址"]);
    add(item.projectTypes, base["项目性质"]);
    const baseDate = parseDate(base["业务日期"]);
    if (baseDate && (!item.businessDate || baseDate < item.businessDate)) item.businessDate = baseDate;
    if (base["数据状态"] != null && !item.documentStatus) item.documentStatus = text(base["数据状态"]);
    if (base["项目状态"] != null && !item.projectStatus) item.projectStatus = text(base["项目状态"]);
    const amount = numberOrNull(base["合同金额"]);
    const noTax = numberOrNull(base["合同不含税金额"]);
    const gross = numberOrNull(base["预计毛利(不含税)"]);
    const rate = numberOrNull(base["预计毛利率(不含税)(%)"]);
    if (amount != null) item.contractAmount = amount;
    if (noTax != null) item.noTaxContractAmount = noTax;
    if (gross != null) item.expectedGrossProfit = gross;
    if (rate != null) item.expectedGrossMarginRate = rate;
    else if (item.expectedGrossMarginRate == null && item.noTaxContractAmount) {
      item.expectedGrossMarginRate = item.expectedGrossProfit / item.noTaxContractAmount * 100;
      item.expectedMarginSource = "derived";
    }
    const beginInvoice = numberOrNull(base["初始已开票金额"]);
    const beginReceive = numberOrNull(base["初始已收款金额"]);
    if (beginInvoice != null) item.beginInvoiceAmount = beginInvoice;
    if (beginReceive != null) item.beginReceiveAmount = beginReceive;
  }
  return item;
}

function amountRate(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator * 100) : null;
}

function sourceGap(item, sourceId) {
  item.sourceGaps.add(sourceId);
}

function aggregateSalesBusiness({
  subprojectRows = [],
  orderRows = [],
  outboundRows = [],
  invoiceRows = [],
  receivableRows = [],
  receiptRows = [],
  refundRows = [],
  contractRows = [],
  sourceStatus = [],
  dateFrom,
  dateTo,
  partial = false,
  includeDetails = false,
  maxDetailRows = 300,
}) {
  const subprojects = new Map();
  let rowsWithoutSubproject = 0;
  for (const row of subprojectRows) {
    const code = text(row["销售子项目编码"]);
    if (!code) { rowsWithoutSubproject += 1; continue; }
    ensureSubproject(subprojects, code, row);
  }
  const orderCodesByBill = new Map();
  for (const row of orderRows) {
    const bill = text(row["销售订单号"]);
    const code = text(row["销售子项目编码"]);
    if (bill && code) orderCodesByBill.set(bill, code);
  }
  const fallbackCode = (row, billField = "源单单号") => {
    const direct = text(row["销售子项目编码"]);
    if (direct) return direct;
    const sourceBill = text(row[billField]);
    return orderCodesByBill.get(sourceBill) || "";
  };

  const orderBills = new Map();
  for (const row of orderRows) {
    const code = fallbackCode(row, "销售订单号");
    if (!code) { rowsWithoutSubproject += 1; continue; }
    const item = ensureSubproject(subprojects, code);
    const bill = text(row["销售订单号"]);
    if (!bill) { sourceGap(item, "orders"); continue; }
    const lineAmount = firstNumber(row, ["订单明细价税合计(本位币)", "订单明细金额(本位币)", "订单明细价税合计", "订单明细金额"]);
    const billHeaderAmount = firstNumber(row, ["订单价税合计(本位币)", "订单价税合计"]);
    // Some sales orders expose a zero header total while the entry amount is
    // populated.  Use the line total as a conservative fallback, but still
    // de-duplicate the fallback at bill + sub-project grain below.
    const billAmount = billHeaderAmount != null && Math.abs(billHeaderAmount) > 0.004 ? billHeaderAmount : lineAmount;
    const billKey = `${key(code)}|${bill}`;
    if (!orderBills.has(billKey)) {
      orderBills.set(billKey, { item, amount: billAmount || 0, noTaxAmount: 0, row });
      item.orderNumbers.add(bill);
      item.orderAmount += billAmount || 0;
    } else if (billAmount != null && Math.abs(billAmount) > Math.abs(orderBills.get(billKey).amount)) {
      item.orderAmount += billAmount - orderBills.get(billKey).amount;
      orderBills.get(billKey).amount = billAmount;
    }
    const noTaxLineAmount = firstNumber(row, ["订单明细金额(本位币)", "订单明细金额"]);
    const orderedQty = firstNumber(row, ["订单基本数量", "订单数量"]);
    const shippedQty = firstNumber(row, ["累计出库基本数量", "累计出库数量"]);
    const returnQty = firstNumber(row, ["累计退货基本数量", "累计退货数量"]);
    const remainQty = firstNumber(row, ["剩余出库基本数量", "剩余出库数量"]);
    item.orderNoTaxAmount += noTaxLineAmount || 0;
    item.orderedQty += orderedQty || 0;
    item.shippedQty += shippedQty || 0;
    item.returnQty += returnQty || 0;
    if (remainQty != null) { item.remainingQty += remainQty; item.hasRemainingQty = true; }
    add(item.customers, row["客户"]);
    add(item.projectCodes, row["销售项目编码"]);
    add(item.salespersons, row["销售员"]);
    add(item.salesOrganizations, row["销售组织"]);
    if (includeDetails) item.orderRows.push({
      销售订单号: bill,
      订单日期: parseDate(row["订单日期"]),
      销售组织: text(row["销售组织"]),
      客户: text(row["客户"]),
      销售员: text(row["销售员"]),
      物料编码: text(row["物料编码"]),
      物料名称: text(row["物料名称"]),
      订单数量: orderedQty,
      订单明细金额: lineAmount,
      累计出库数量: shippedQty,
      累计退货数量: returnQty,
      剩余出库数量: remainQty,
      计划交货日期: parseDate(row["计划交货日期"]),
      审核状态: text(row["审核状态"]),
      关闭状态: text(row["关闭状态"]),
    });
  }

  const outboundBills = new Map();
  for (const row of outboundRows) {
    const code = fallbackCode(row);
    if (!code) { rowsWithoutSubproject += 1; continue; }
    const item = ensureSubproject(subprojects, code);
    const bill = text(row["销售出库单号"]);
    if (bill) item.outboundNumbers.add(bill);
    const qty = firstNumber(row, ["实发数量", "出库基本数量"]);
    const baseQty = firstNumber(row, ["出库基本数量", "实发数量"]);
    const signQty = firstNumber(row, ["累计签收数量", "签收数量"]);
    const amount = firstNumber(row, ["出库价税合计(本位币)", "出库金额(本位币)", "出库价税合计", "出库金额"]);
    item.outboundQty += baseQty || 0;
    item.signedQty += signQty || 0;
    item.outboundAmount += amount || 0;
    add(item.customers, row["客户"]);
    add(item.salespersons, row["销售员"]);
    if (includeDetails) item.outboundRows.push({
      销售出库单号: bill,
      出库日期: parseDate(row["出库日期"]),
      客户: text(row["客户"]),
      销售员: text(row["销售员"]),
      物料编码: text(row["物料编码"]),
      物料名称: text(row["物料名称"]),
      出库基本数量: baseQty,
      实发数量: qty,
      签收数量: signQty,
      出库金额: amount,
      源单单号: text(row["源单单号"]),
    });
  }

  for (const row of invoiceRows) {
    const code = text(row["销售子项目编码"]);
    if (!code) { rowsWithoutSubproject += 1; continue; }
    const item = ensureSubproject(subprojects, code);
    const bill = text(row["销售发票号"]);
    if (bill) item.invoiceNumbers.add(bill);
    item.invoiceAmount += signedInvoiceAmount(row);
    add(item.customers, row["客户"]);
    if (includeDetails) item.invoiceRows.push({
      销售发票号: bill,
      开票日期: parseDate(row["开票日期"]),
      客户: text(row["客户"]),
      发票金额: signedInvoiceAmount(row),
      红蓝字标识: text(row["红蓝字标识"]),
    });
  }

  for (const row of receivableRows) {
    const code = text(row["销售子项目编码"]);
    if (!code) { rowsWithoutSubproject += 1; continue; }
    const item = ensureSubproject(subprojects, code);
    const bill = text(row["应收单号"]);
    if (bill) item.receivableNumbers.add(bill);
    item.receivableAmount += number(row["应收单总额"]);
    item.receivableReceivedAmount += number(row["已收金额"]);
    item.receivableOutstandingAmount += number(row["未收金额"]);
    add(item.customers, row["客户"]);
    if (includeDetails) item.receivableRows.push({
      应收单号: bill,
      应收日期: parseDate(row["应收日期"]),
      客户: text(row["客户"]),
      应收单总额: number(row["应收单总额"]),
      已收金额: number(row["已收金额"]),
      未收金额: number(row["未收金额"]),
    });
  }

  for (const row of receiptRows) {
    const code = text(row["销售子项目编码"]);
    if (!code) { rowsWithoutSubproject += 1; continue; }
    const item = ensureSubproject(subprojects, code);
    const bill = text(row["收款单号"]);
    if (bill) item.receiptNumbers.add(bill);
    item.receiptAmount += number(row["收款金额"]);
    if (includeDetails) item.receiptRows.push({ 收款单号: bill, 收款日期: parseDate(row["收款日期"]), 收款金额: number(row["收款金额"]) });
  }

  for (const row of refundRows) {
    const code = text(row["销售子项目编码"]);
    if (!code) { rowsWithoutSubproject += 1; continue; }
    const item = ensureSubproject(subprojects, code);
    const bill = text(row["退款单号"]);
    if (bill) item.refundNumbers.add(bill);
    item.refundAmount += number(row["退款金额"]);
    if (includeDetails) item.refundRows.push({ 退款单号: bill, 退款日期: parseDate(row["退款日期"]), 退款金额: number(row["退款金额"]) });
  }

  for (const row of contractRows) {
    const code = text(row["销售子项目编码"]);
    if (!code) { rowsWithoutSubproject += 1; continue; }
    const item = ensureSubproject(subprojects, code);
    const bill = text(row["合同号"] || row["合同单号"]);
    if (bill) item.contractNumbers.add(bill);
    const amount = numberOrNull(row["合同金额"]);
    const gross = numberOrNull(row["预计毛利(不含税)"]);
    if (amount != null && item.contractAmount === 0) item.contractAmount = amount;
    if (gross != null && item.expectedGrossProfit === 0) item.expectedGrossProfit = gross;
  }

  if (includeDetails) {
    for (const item of subprojects.values()) {
      item.detailTruncated = [item.orderRows, item.outboundRows, item.invoiceRows, item.receivableRows, item.receiptRows, item.refundRows]
        .some((rows) => rows.length > maxDetailRows);
      item.orderRows = item.orderRows.slice(0, maxDetailRows);
      item.outboundRows = item.outboundRows.slice(0, maxDetailRows);
      item.invoiceRows = item.invoiceRows.slice(0, maxDetailRows);
      item.receivableRows = item.receivableRows.slice(0, maxDetailRows);
      item.receiptRows = item.receiptRows.slice(0, maxDetailRows);
      item.refundRows = item.refundRows.slice(0, maxDetailRows);
    }
  }

  const rows = [...subprojects.values()].map((item) => {
    const netDeliveredQty = item.shippedQty - item.returnQty;
    const pendingQty = Math.max(0, item.orderedQty - netDeliveredQty);
    const remainingQty = item.hasRemainingQty ? item.remainingQty : pendingQty;
    const netReceiptAmount = item.receiptAmount - item.refundAmount;
    const expectedRate = item.expectedGrossMarginRate == null && item.noTaxContractAmount
      ? item.expectedGrossProfit / item.noTaxContractAmount * 100
      : item.expectedGrossMarginRate;
    const outstandingPositive = Math.max(0, item.receivableOutstandingAmount);
    const status = outstandingPositive > 0.004
      ? (item.receivableReceivedAmount > 0.004 ? "部分回款未结清" : "有应收未收")
      : (netReceiptAmount > 0.004 || item.receivableReceivedAmount > 0.004 ? "已有回款" : "未形成应收");
    const gaps = new Set(item.sourceGaps);
    if (!item.orderNumbers.size) gaps.add("orders");
    if (!item.invoiceNumbers.size && !item.receivableNumbers.size) gaps.add("finance");
    const sourceLabels = { orders: "销售订单", finance: "开票/应收", outbound: "销售出库" };
    const completeness = gaps.size ? `缺少${[...gaps].map((value) => sourceLabels[value] || value).join("、")}来源` : "已关联主要来源";
    const row = {
      客户: join(item.customers),
      销售项目编码: join(item.projectCodes),
      销售项目名称: join(item.projectNames),
      销售子项目编码: item.code,
      销售子项目名称: join(item.names),
      客户经理: join(item.customerManagers),
      项目经理: join(item.projectManagers),
      销售员: join(item.salespersons),
      销售组织: join(item.salesOrganizations),
      业务日期: item.businessDate,
      数据状态: item.documentStatus,
      项目状态: item.projectStatus,
      预计毛利率: expectedRate == null ? null : round(expectedRate),
      预计毛利率来源: item.expectedMarginSource === "derived" ? "按预计毛利/合同不含税金额推导" : "金蝶字段 FGrossProfitRate",
      预计毛利: round(item.expectedGrossProfit),
      合同金额: round(item.contractAmount),
      合同不含税金额: round(item.noTaxContractAmount),
      初始已开票金额: round(item.beginInvoiceAmount),
      初始已收款金额: round(item.beginReceiveAmount),
      合同数: item.contractNumbers.size || item.contractCodes.size,
      销售订单数: item.orderNumbers.size,
      订单金额: round(item.orderAmount),
      订单不含税金额: round(item.orderNoTaxAmount),
      订单数量: round(item.orderedQty, 6),
      出库数量: round(item.outboundQty, 6),
      累计出库数量: round(item.shippedQty, 6),
      退货数量: round(item.returnQty, 6),
      净交付数量: round(netDeliveredQty, 6),
      未交付数量: round(remainingQty, 6),
      交付完成率: amountRate(netDeliveredQty, item.orderedQty),
      签收数量: round(item.signedQty, 6),
      出库金额: round(item.outboundAmount),
      销售发票数: item.invoiceNumbers.size,
      开票金额: round(item.invoiceAmount),
      应收单数: item.receivableNumbers.size,
      应收金额: round(item.receivableAmount),
      应收已收款金额: round(item.receivableReceivedAmount),
      应收未收款金额: round(item.receivableOutstandingAmount),
      收款单数: item.receiptNumbers.size,
      收款金额: round(item.receiptAmount),
      退款金额: round(item.refundAmount),
      收款净额: round(netReceiptAmount),
      回款覆盖率: amountRate(item.receivableReceivedAmount, item.receivableAmount),
      回款状态: status,
      收款条件: join(item.paymentConditions),
      数据完整性: completeness,
    };
    if (includeDetails) {
      row.details = {
        subproject: {
          销售子项目编码: item.code,
          销售子项目名称: join(item.names),
          客户: join(item.customers),
          销售项目: join(item.projectCodes),
          预计毛利率: expectedRate == null ? null : round(expectedRate),
          预计毛利: round(item.expectedGrossProfit),
          合同不含税金额: round(item.noTaxContractAmount),
          收款条件: join(item.paymentConditions),
        },
        orders: item.orderRows,
        outbound: item.outboundRows,
        invoices: item.invoiceRows,
        receivables: item.receivableRows,
        receipts: item.receiptRows,
        refunds: item.refundRows,
        truncated: Boolean(item.detailTruncated),
      };
    }
    return row;
  }).sort((left, right) => (Number(right["应收未收款金额"]) || 0) - (Number(left["应收未收款金额"]) || 0)
    || (Number(right["预计毛利"]) || 0) - (Number(left["预计毛利"]) || 0)
    || String(left["销售子项目编码"]).localeCompare(String(right["销售子项目编码"]), "zh-CN", { numeric: true }));

  const sourceById = new Map(sourceStatus.map((source) => [source.id, source]));
  const sum = (field) => round(rows.reduce((total, row) => total + (Number(row[field]) || 0), 0));
  const noTaxContractAmount = sum("合同不含税金额");
  const expectedGrossProfit = sum("预计毛利");
  const statistics = {
    type: "sales_business_analysis",
    dateFrom,
    dateTo,
    subprojectCount: rows.length,
    projectCount: new Set(rows.map((row) => row["销售项目编码"]).filter(Boolean)).size,
    customerCount: new Set(rows.map((row) => row["客户"]).filter(Boolean)).size,
    contractCount: rows.reduce((total, row) => total + (Number(row["合同数"]) || 0), 0),
    contractAmount: sum("合同金额"),
    noTaxContractAmount,
    expectedGrossProfit,
    expectedGrossMarginRate: amountRate(expectedGrossProfit, noTaxContractAmount),
    orderCount: rows.reduce((total, row) => total + (Number(row["销售订单数"]) || 0), 0),
    orderAmount: sum("订单金额"),
    orderNoTaxAmount: sum("订单不含税金额"),
    orderedQty: round(rows.reduce((total, row) => total + (Number(row["订单数量"]) || 0), 0), 6),
    outboundQty: round(rows.reduce((total, row) => total + (Number(row["出库数量"]) || 0), 0), 6),
    shippedQty: round(rows.reduce((total, row) => total + (Number(row["累计出库数量"]) || 0), 0), 6),
    returnQty: round(rows.reduce((total, row) => total + (Number(row["退货数量"]) || 0), 0), 6),
    netDeliveredQty: round(rows.reduce((total, row) => total + (Number(row["净交付数量"]) || 0), 0), 6),
    remainingQty: round(rows.reduce((total, row) => total + (Number(row["未交付数量"]) || 0), 0), 6),
    deliveryCompletionRate: amountRate(rows.reduce((total, row) => total + (Number(row["净交付数量"]) || 0), 0), rows.reduce((total, row) => total + (Number(row["订单数量"]) || 0), 0)),
    signedQty: round(rows.reduce((total, row) => total + (Number(row["签收数量"]) || 0), 0), 6),
    outboundAmount: sum("出库金额"),
    invoiceCount: rows.reduce((total, row) => total + (Number(row["销售发票数"]) || 0), 0),
    invoiceAmount: sum("开票金额"),
    receivableBillCount: rows.reduce((total, row) => total + (Number(row["应收单数"]) || 0), 0),
    receivableAmount: sum("应收金额"),
    receivedAmount: sum("应收已收款金额"),
    outstandingAmount: sum("应收未收款金额"),
    positiveOutstandingAmount: round(rows.reduce((total, row) => total + Math.max(0, Number(row["应收未收款金额"]) || 0), 0)),
    receiptCount: rows.reduce((total, row) => total + (Number(row["收款单数"]) || 0), 0),
    receiptAmount: sum("收款金额"),
    refundAmount: sum("退款金额"),
    netReceiptAmount: sum("收款净额"),
    collectionCoverageRate: amountRate(rows.reduce((total, row) => total + (Number(row["应收已收款金额"]) || 0), 0), rows.reduce((total, row) => total + (Number(row["应收金额"]) || 0), 0)),
    riskSubprojectCount: rows.filter((row) => (Number(row["应收未收款金额"]) || 0) > 0.004).length,
    rowsWithoutSubproject,
    partial: Boolean(partial || sourceStatus.some((source) => !source.available)),
    unavailableSources: sourceStatus.filter((source) => !source.available).map((source) => source.id),
    availableSourceCount: sourceStatus.filter((source) => source.available).length,
    sourceCount: sourceStatus.length,
  };
  const money = (value) => new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const rate = statistics.expectedGrossMarginRate == null ? "—" : `${statistics.expectedGrossMarginRate.toFixed(2)}%`;
  const summary = rows.length
    ? `${dateFrom} 至 ${dateTo} 共 ${rows.length} 个销售子项目，合同不含税金额 ¥${money(noTaxContractAmount)}，预计毛利 ¥${money(expectedGrossProfit)}，加权预计毛利率 ${rate}；订单 ${statistics.orderCount} 张，净交付 ${statistics.netDeliveredQty}，应收未收款 ¥${money(statistics.positiveOutstandingAmount)}${statistics.partial ? "（部分来源不可用，详见数据状态）" : ""}。`
    : `${dateFrom} 至 ${dateTo} 没有找到已审核的销售子项目。`;
  return {
    rows,
    statistics,
    sourceStatus,
    summary,
    details: includeDetails ? rows.map((row) => row.details).filter(Boolean) : [],
    sourceById,
  };
}

module.exports = {
  salesBusinessDateRange,
  buildSalesBusinessSourceFilter,
  aggregateSalesBusiness,
  signedInvoiceAmount,
};
