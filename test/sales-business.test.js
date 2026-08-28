const test = require("node:test");
const assert = require("node:assert/strict");
const {
  aggregateSalesBusiness,
  salesBusinessDateRange,
  buildSalesBusinessSourceFilter,
  signedInvoiceAmount,
} = require("../src/sales-business");
const { QueryEngine } = require("../src/query-engine");
const catalog = require("../config/query-catalog.json");

test("bounds the sales business date range and builds only catalogue filters", () => {
  assert.deepEqual(salesBusinessDateRange({ dateFrom: "2026-01-01", dateTo: "2026-01-31" }, new Date("2026-08-28T00:00:00Z")), {
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
    dateToExclusive: "2026-02-01",
    days: 31,
  });
  assert.throws(() => salesBusinessDateRange({ dateFrom: "2026-01-01", dateTo: "2027-01-02" }, new Date("2026-08-28T00:00:00Z")), /最多为 366 天/);
  const filter = buildSalesBusinessSourceFilter({
    dateField: "FDate",
    customerField: "FCustId.FName",
    billField: "FBillNo",
    filter: "FDocumentStatus='C'",
  }, { dateFrom: "2026-01-01", dateTo: "2026-01-31", customerName: "甲'客户", billNumber: "SO001" }, {
    dateFrom: "2026-01-01", dateTo: "2026-01-31", dateToExclusive: "2026-02-01",
  });
  assert.equal(filter, "FDocumentStatus='C' AND FDate>='2026-01-01' AND FDate<'2026-02-01' AND FBillNo='SO001' AND FCustId.FName LIKE '%甲''客户%'");
});

test("keeps expected gross margin as a field and aggregates operational and financial stages", () => {
  const result = aggregateSalesBusiness({
    subprojectRows: [{
      "销售子项目编码": "SP001", "销售子项目名称": "一期", "销售项目编码": "P001", "销售项目名称": "项目一",
      "销售合同编码": "C001", "客户编码": "CU001", "客户": "客户甲", "客户经理": "经理甲", "项目经理": "项目经理甲",
      "业务日期": "2026-01-02", "数据状态": "C", "项目状态": "A", "合同金额": 330, "合同不含税金额": 300,
      "预计毛利(不含税)": 100, "预计毛利率(不含税)(%)": 33.79, "初始已开票金额": 0, "初始已收款金额": 0, "收款条件": "30天",
    }],
    contractRows: [{ "合同号": "CT001", "销售子项目编码": "SP001", "合同金额": 330, "预计毛利(不含税)": 100 }],
    orderRows: [
      { "销售订单号": "SO001", "订单日期": "2026-01-03", "销售组织": "销售组织", "销售员": "销售员甲", "客户": "客户甲", "物料编码": "M1", "物料名称": "物料一", "订单价税合计": 500, "订单价税合计(本位币)": 500, "订单明细价税合计(本位币)": 200, "订单明细金额(本位币)": 180, "订单基本数量": 10, "累计出库基本数量": 6, "累计退货基本数量": 1, "剩余出库基本数量": 5, "销售子项目编码": "SP001" },
      { "销售订单号": "SO001", "订单日期": "2026-01-03", "销售组织": "销售组织", "销售员": "销售员甲", "客户": "客户甲", "物料编码": "M2", "物料名称": "物料二", "订单价税合计": 500, "订单价税合计(本位币)": 500, "订单明细价税合计(本位币)": 300, "订单明细金额(本位币)": 270, "订单基本数量": 5, "累计出库基本数量": 2, "累计退货基本数量": 0, "剩余出库基本数量": 3, "销售子项目编码": "SP001" },
    ],
    outboundRows: [{ "销售出库单号": "OUT001", "出库日期": "2026-01-05", "客户": "客户甲", "物料编码": "M1", "物料名称": "物料一", "出库基本数量": 8, "实发数量": 8, "出库价税合计(本位币)": 400, "源单单号": "SO001", "销售子项目编码": "SP001", "签收数量": 5, "累计签收数量": 5 }],
    invoiceRows: [
      { "销售发票号": "INV001", "开票日期": "2026-01-10", "客户": "客户甲", "销售子项目编码": "SP001", "发票金额": 300, "红蓝字标识": "0" },
      { "销售发票号": "INV002", "开票日期": "2026-01-11", "客户": "客户甲", "销售子项目编码": "SP001", "发票金额": 20, "红蓝字标识": "1" },
    ],
    receivableRows: [{ "应收单号": "AR001", "应收日期": "2026-01-12", "客户": "客户甲", "销售子项目编码": "SP001", "应收单总额": 280, "已收金额": 100, "未收金额": 180 }],
    receiptRows: [{ "收款单号": "REC001", "收款日期": "2026-01-15", "销售子项目编码": "SP001", "收款金额": 120 }],
    refundRows: [{ "退款单号": "REF001", "退款日期": "2026-01-16", "销售子项目编码": "SP001", "退款金额": 10 }],
    sourceStatus: ["subprojects", "contracts", "orders", "outbound", "invoices", "receivables", "receipts", "refunds"].map((id) => ({ id, label: id, available: true, rows: 1 })),
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
    includeDetails: true,
  });
  assert.equal(signedInvoiceAmount({ "发票金额": 20, "红蓝字标识": "1" }), -20);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row["预计毛利率"], 33.79);
  assert.equal(row["预计毛利"], 100);
  assert.equal(row["销售订单数"], 1);
  assert.equal(row["订单金额"], 500);
  assert.equal(row["订单数量"], 15);
  assert.equal(row["累计出库数量"], 8);
  assert.equal(row["退货数量"], 1);
  assert.equal(row["净交付数量"], 7);
  assert.equal(row["未交付数量"], 8);
  assert.equal(row["交付完成率"], 46.67);
  assert.equal(row["开票金额"], 280);
  assert.equal(row["应收未收款金额"], 180);
  assert.equal(row["收款净额"], 110);
  assert.equal(row["回款状态"], "部分回款未结清");
  assert.equal(result.statistics.expectedGrossMarginRate, 33.33);
  assert.equal(result.statistics.positiveOutstandingAmount, 180);
  assert.equal(result.statistics.partial, false);
  assert.equal(result.details[0].orders.length, 2);
  assert.equal(result.details[0].invoices.length, 2);
});

test("marks unavailable downstream sources as partial without losing the project margin row", () => {
  const result = aggregateSalesBusiness({
    subprojectRows: [{ "销售子项目编码": "SP002", "销售子项目名称": "二期", "客户": "客户乙", "业务日期": "2026-02-01", "合同不含税金额": 100, "预计毛利(不含税)": -10, "预计毛利率(不含税)(%)": -10, "数据状态": "C" }],
    sourceStatus: [
      { id: "subprojects", label: "销售子项目", available: true, rows: 1 },
      { id: "orders", label: "销售订单", available: false, rows: 0, reason: "权限不足" },
    ],
    dateFrom: "2026-02-01",
    dateTo: "2026-02-28",
  });
  assert.equal(result.statistics.partial, true);
  assert.equal(result.rows[0]["预计毛利率"], -10);
  assert.match(result.rows[0]["数据完整性"], /销售订单/);
  assert.match(result.summary, /部分来源不可用/);
});

test("uses sales-list tax-exclusive amounts when the header amount is empty", () => {
  const result = aggregateSalesBusiness({
    subprojectRows: [{
      "销售子项目编码": "SP003", "销售子项目名称": "三期", "合同金额": 1130,
      "合同不含税金额": 0, "预计毛利(不含税)": 100, "预计毛利率(不含税)(%)": 10,
    }],
    subprojectLineRows: [
      { "销售子项目编码": "SP003", "销售清单不含税金额": 1000 },
      { "销售子项目编码": "SP003", "销售清单不含税金额": 0 },
    ],
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
  });
  assert.equal(result.rows[0]["合同不含税金额"], 1000);
  assert.match(result.rows[0]["合同不含税金额来源"], /销售清单 FAmount 汇总/);
  assert.equal(result.statistics.expectedGrossMarginRate, 10);
  assert.equal(result.statistics.noTaxContractAmountFallbackRows, 1);
  assert.equal(result.statistics.noTaxContractAmountMissingRows, 0);
});

test("queries the sales subproject anchor and every downstream source with stable pagination", async () => {
  const item = catalog.sales_business_analysis;
  const requests = [];
  const objects = {
    subprojects: [{ "销售子项目编码": "SP001", "销售子项目名称": "一期", "销售项目编码": "P001", "销售项目名称": "项目一", "客户编码": "CU001", "客户": "客户甲", "业务日期": "2026-01-02", "数据状态": "C", "项目状态": "A", "合同金额": 100, "合同不含税金额": 0, "预计毛利(不含税)": 20, "预计毛利率(不含税)(%)": 22.22 }],
    subprojectLines: [{ "销售子项目编码": "SP001", "销售清单不含税金额": 90 }],
    contracts: [{ "合同单号": "C001", "合同号": "C001", "销售项目编码": "P001", "销售子项目编码": "SP001", "客户编码": "CU001", "客户": "客户甲", "合同日期": "2026-01-03", "数据状态": "C", "作废状态": "A", "合同金额": 100, "预计毛利(不含税)": 20, "预计毛利率(不含税)(%)": 22.22 }],
    orders: [{ "销售订单号": "SO001", "订单日期": "2026-01-04", "销售组织": "销售组织", "客户": "客户甲", "销售员": "销售员", "审核状态": "C", "关闭状态": "A", "作废状态": "A", "订单价税合计": 100, "订单价税合计(本位币)": 100, "物料编码": "M1", "物料名称": "物料", "订单数量": 1, "订单基本数量": 1, "订单明细金额": 90, "订单明细金额(本位币)": 90, "订单明细价税合计": 100, "订单明细价税合计(本位币)": 100, "累计出库数量": 1, "累计出库基本数量": 1, "累计退货数量": 0, "累计退货基本数量": 0, "剩余出库数量": 0, "剩余出库基本数量": 0, "计划交货日期": "2026-01-05", "发货状态": "C", "销售项目编码": "P001", "销售子项目编码": "SP001", "源单类型": "", "源单单号": "" }],
    outbound: [{ "销售出库单号": "OUT001", "出库日期": "2026-01-06", "审核状态": "C", "作废状态": "A", "客户": "客户甲", "销售员": "销售员", "物料编码": "M1", "物料名称": "物料", "出库基本数量": 1, "实发数量": 1, "出库金额(本位币)": 100, "出库价税合计(本位币)": 100, "源单单号": "SO001", "销售项目编码": "P001", "销售子项目编码": "SP001", "签收数量": 1, "累计签收数量": 1, "剩余销售数量": 0, "剩余签收数量": 0, "销售订单数量": 1 }],
    invoices: [{ "销售发票号": "INV001", "开票日期": "2026-01-07", "审核状态": "C", "作废状态": "A", "客户": "客户甲", "销售子项目编码": "SP001", "发票金额": 100, "红蓝字标识": "0" }],
    receivables: [{ "应收单号": "AR001", "应收日期": "2026-01-08", "审核状态": "C", "作废状态": "A", "客户": "客户甲", "销售子项目编码": "SP001", "应收单总额": 100, "已收金额": 50, "未收金额": 50 }],
    receipts: [{ "收款单号": "REC001", "收款日期": "2026-01-09", "审核状态": "C", "作废状态": "A", "销售子项目编码": "SP001", "销售子项目名称": "一期", "收款金额": 50 }],
    refunds: [{ "退款单号": "REF001", "退款日期": "2026-01-10", "审核状态": "C", "作废状态": "A", "销售子项目编码": "SP001", "销售子项目名称": "一期", "退款金额": 0 }],
  };
  const kingdee = { executeBillQuery: async (username, request) => {
    assert.equal(username, "240001");
    requests.push(request);
    const found = Object.entries(item.sources)
      .map(([id, source]) => ({ id, source }))
      .find(({ source }) => source.formId === request.FormId && source.fields.map(([key]) => key).join(",") === request.FieldKeys);
    if (!found) throw new Error(`unexpected form ${request.FormId}`);
    const rows = (objects[found.id] || []).map((row) => found.source.fields.map(([, label]) => row[label]));
    return rows;
  } };
  const engine = new QueryEngine({
    catalog,
    kingdee,
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 100, queryPageSize: 5000 } },
    now: () => new Date("2026-08-28T00:00:00Z"),
  });
  const result = await engine.execute({ kingdeeUsername: "240001" }, { tool: "sales_business_analysis", arguments: { dateFrom: "2026-01-01", dateTo: "2026-01-31", subprojectNumber: "SP001", limit: 1 } });
  assert.equal(requests.length, 9);
  assert.ok(requests.every((request) => request.TopRowCount === 0 && request.StartRow === 0 && request.Limit === 5000));
  const orderRequest = requests.find((request) => request.FormId === "SAL_SaleOrder");
  assert.match(orderRequest.FilterString, /F_PARA_SaleSubProId\.FNumber IN \('SP001'\)/);
  assert.match(orderRequest.FilterString, /FDate>='2026-01-01'/);
  const subprojectRequest = requests.find((request) => request.FormId === "PARA_SaleSubProject");
  assert.match(subprojectRequest.FilterString, /FBillNo LIKE '%SP001%'/);
  const subprojectLineRequest = requests.find((request) => request.FieldKeys === "FBillNo,FAmount");
  assert.match(subprojectLineRequest.FilterString, /FBillNo IN \('SP001'\)/);
  assert.equal(result.rows[0]["预计毛利率"], 22.22);
  assert.equal(result.rows[0]["合同不含税金额"], 90);
  assert.match(result.rows[0]["合同不含税金额来源"], /销售清单 FAmount 汇总/);
  assert.equal(result.rows[0]["销售订单数"], 1);
  assert.equal(result.rows[0]["应收未收款金额"], 50);
});
