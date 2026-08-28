const test = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("../config/query-catalog.json");
const { QueryEngine } = require("../src/query-engine");
const { aggregateSupplierPurchase } = require("../src/supplier-purchase");

function baseSourceStatus() {
  return [
    { id: "orders", label: "采购订单", available: true, rows: 2 },
    { id: "receipts", label: "收料单", available: true, rows: 1 },
    { id: "inbound", label: "采购入库", available: true, rows: 1 },
    { id: "returns", label: "采购退料", available: true, rows: 1 },
    { id: "payables", label: "应付单", available: true, rows: 1 },
    { id: "payments", label: "付款单", available: true, rows: 1 },
    { id: "invoices", label: "采购发票", available: true, rows: 1 },
    { id: "quality", label: "质量检验", available: false, rows: 0, reason: "模块未购买" },
  ];
}

test("aggregates supplier procurement by bill and keeps signed invoice amounts", () => {
  const result = aggregateSupplierPurchase({
    dateFrom: "2026-01-01",
    dateTo: "2026-08-28",
    sourceStatus: baseSourceStatus(),
    purchaseRows: [
      { "采购订单号": "PO-1", "采购日期": "2026-01-02", "供应商编码": "S1", "供应商": "甲供应商", "采购组织": "组织A", "审核状态": "C", "订单价税合计(本位币)": 100, "物料编码": "M1", "物料名称": "物料一", "采购基本数量": 10, "含税单价": 10, "明细价税合计(本位币)": 100, "累计入库数量(基本)": 8, "累计退料数量(基本)": 1, "最晚交货日期": "2026-01-10" },
      { "采购订单号": "PO-1", "采购日期": "2026-01-02", "供应商编码": "S1", "供应商": "甲供应商", "采购组织": "组织A", "审核状态": "C", "订单价税合计(本位币)": 100, "物料编码": "M2", "物料名称": "物料二", "采购基本数量": 5, "含税单价": 20, "明细价税合计(本位币)": 100, "累计入库数量(基本)": 5, "累计退料数量(基本)": 0, "最晚交货日期": "2026-01-10" },
      { "采购订单号": "PO-2", "采购日期": "2026-03-02", "供应商编码": "S2", "供应商": "乙供应商", "审核状态": "C", "订单价税合计(本位币)": 300, "物料编码": "M3", "物料名称": "物料三", "采购基本数量": 3, "含税单价": 100, "明细价税合计(本位币)": 300, "累计入库数量(基本)": 0, "累计退料数量(基本)": 0, "最晚交货日期": "2026-03-10" },
    ],
    receiveRows: [{ "收料单号": "RC-1", "收料日期": "2026-01-05", "供应商编码": "S1", "供应商": "甲供应商", "物料编码": "M1", "收料基本数量": 8 }],
    inboundRows: [{ "入库单号": "IN-1", "入库日期": "2026-01-06", "供应商编码": "S1", "供应商": "甲供应商", "物料编码": "M1", "入库基本数量": 8, "入库价税合计(本位币)": 80 }],
    returnRows: [{ "退料单号": "RT-1", "退料日期": "2026-01-07", "供应商编码": "S1", "供应商": "甲供应商", "物料编码": "M1", "退料基本数量": 1, "退料价税合计(本位币)": 10 }],
    payableRows: [{ "应付单号": "AP-1", "应付日期": "2026-01-08", "供应商编码": "S1", "供应商": "甲供应商", "应付价税合计(本位币)": 80, "未开票核销金额": 20 }],
    paymentRows: [{ "付款单号": "PAY-1", "付款日期": "2026-01-09", "供应商编码": "S1", "供应商": "甲供应商", "实付金额(本位币)": 50 }],
    invoiceRows: [{ "采购发票号": "INV-1", "发票日期": "2026-01-10", "供应商编码": "S1", "供应商": "甲供应商", "采购发票金额(本位币)": 70, "红蓝字": "1" }],
    qualityRows: [],
  });
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]["供应商编码"], "S2");
  const supplier = result.rows.find((row) => row["供应商编码"] === "S1");
  assert.equal(supplier["订单金额"], 200);
  assert.equal(supplier["净采购金额"], 190);
  assert.equal(supplier["入库数量"], 8);
  assert.equal(supplier["退料金额"], 10);
  assert.equal(supplier["已付款金额"], 50);
  assert.equal(supplier["采购发票金额"], -70);
  assert.equal(result.partial, true);
  assert.equal(result.details, null);
});

function rowFor(source, values) {
  return source.fields.map(([, label]) => values[label] ?? "");
}

test("executes all supplier sources with bounded date and supplier filters", async () => {
  const item = catalog.supplier_purchase_analysis;
  const requests = [];
  const byForm = new Map(Object.entries(item.sources).map(([id, source]) => [source.formId, { id, source }]));
  const fakeKingdee = {
    async executeBillQuery(user, request) {
      requests.push({ user, request });
      const match = byForm.get(request.FormId);
      if (!match) return [];
      if (match.id === "quality") throw new Error("质量管理模块未购买");
      const { source } = match;
      if (match.id === "orders") return [rowFor(source, { "采购订单号": "PO-1", "采购日期": "2026-08-01", "供应商编码": "S1", "供应商": "甲供应商", "审核状态": "C", "作废状态": "A", "订单价税合计(本位币)": 120, "物料编码": "M1", "采购基本数量": 2, "明细价税合计(本位币)": 120 })];
      if (match.id === "inbound") return [rowFor(source, { "入库单号": "IN-1", "入库日期": "2026-08-03", "供应商编码": "S1", "供应商": "甲供应商", "入库基本数量": 2, "入库价税合计(本位币)": 120 })];
      if (match.id === "receipts") return [rowFor(source, { "收料单号": "RC-1", "收料日期": "2026-08-02", "供应商编码": "S1", "供应商": "甲供应商", "收料基本数量": 2 })];
      if (match.id === "returns") return [rowFor(source, { "退料单号": "RT-1", "退料日期": "2026-08-04", "供应商编码": "S1", "供应商": "甲供应商", "退料基本数量": 0 })];
      if (match.id === "payables") return [rowFor(source, { "应付单号": "AP-1", "应付日期": "2026-08-05", "供应商编码": "S1", "供应商": "甲供应商", "应付价税合计(本位币)": 120 })];
      if (match.id === "payments") return [rowFor(source, { "付款单号": "PAY-1", "付款日期": "2026-08-06", "往来单位编码": "S1", "往来单位": "甲供应商", "实付金额(本位币)": 60 })];
      if (match.id === "invoices") return [rowFor(source, { "采购发票号": "INV-1", "发票日期": "2026-08-07", "供应商编码": "S1", "供应商": "甲供应商", "采购发票金额(本位币)": 120, "红蓝字": "0" })];
      return [];
    },
  };
  const engine = new QueryEngine({
    catalog,
    kingdee: fakeKingdee,
    config: { kingdee: { queryPageSize: 5000, maxRows: 200 }, scopeAdmins: new Set() },
    now: () => new Date("2026-08-28T00:00:00Z"),
  });
  const result = await engine.execute({ kingdeeUsername: "1" }, { tool: "supplier_purchase_analysis", arguments: { dateFrom: "2026-01-01", dateTo: "2026-08-28", supplierNumber: "S1" } });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]["订单金额"], 120);
  assert.equal(result.details["供应商编码"], "S1");
  assert.equal(result.partial, true);
  assert.equal(requests.length, 8);
  assert.ok(requests.every(({ user, request }) => user === "1" && request.TopRowCount === 0 && request.FilterString.includes("2026-01-01") && request.FilterString.includes("2026-08-29") && request.FilterString.includes("S1")));
});
