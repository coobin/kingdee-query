const test = require("node:test");
const assert = require("node:assert/strict");
const {
  QueryEngine,
  buildFilter,
  rowsToObjects,
  escapeValue,
  buildOverdueReceivableFilter,
  buildOverdueInvoiceFilter,
  aggregateOverdueReceivables,
} = require("../src/query-engine");
const catalog = require("../config/query-catalog.json");

const item = {
  filterFields: { materialNumber: "FMaterialId.FNumber", materialName: "FMaterialId.FName", dateFrom: "FDate" },
  requiresFilter: true,
};
const identity = { kingdeeUsername: "240001", name: "张三" };
const config = { scopeAdmins: new Set() };

test("only catalogued filters become Kingdee filters", () => {
  const result = buildFilter(item, { materialNumber: "A100", malicious: "1=1" }, identity, config);
  assert.equal(result.filter, "FMaterialId.FNumber='A100'");
  assert.equal(result.accepted.malicious, undefined);
});

test("escapes quotes in filter values", () => {
  assert.equal(escapeValue("A' OR 1=1"), "A'' OR 1=1");
});

test("forces expense self scope for non-admin", () => {
  const expense = { filterFields: { dateFrom: "FDate" }, requiresFilter: true, forceSelfScope: true, selfField: "FProposerID.FName", selfValueSource: "name" };
  const result = buildFilter(expense, { dateFrom: "2026-08-01" }, identity, config);
  assert.match(result.filter, /FProposerID\.FName='张三'/);
});

test("maps positional WebAPI rows to labelled objects", () => {
  assert.deepEqual(rowsToObjects([["A100", 12]], [["FNumber", "物料编码"], ["FQty", "数量"]]), [{ 物料编码: "A100", 数量: 12 }]);
});

test("maps document status codes to readable Chinese labels", () => {
  const fields = [["FBillNo", "单据编号"], ["FDocumentStatus", "审核状态"]];
  const mappings = { 审核状态: { A: "已创建", B: "审核中", C: "已审核" } };
  assert.deepEqual(rowsToObjects([["BX001", "C"]], fields, mappings), [{ 单据编号: "BX001", 审核状态: "已审核" }]);
  assert.deepEqual(rowsToObjects([["BX002", "X"]], fields, mappings), [{ 单据编号: "BX002", 审核状态: "其他状态" }]);
});

test("builds a strict over-180-day invoiced receivable filter", () => {
  const result = buildOverdueReceivableFilter({ minimumDays: 180, customerName: "客户'甲", subprojectNumber: "QC-JE" }, "2026-08-13");
  assert.doesNotMatch(result.filter, /FDate|FEndDate/);
  assert.match(result.filter, /FDocumentStatus='C'/);
  assert.match(result.filter, /FIVALLAMOUNTFOR>0/);
  assert.doesNotMatch(result.filter, /FNORECEIVEAMOUNT>0/);
  assert.match(result.filter, /客户''甲/);
  assert.match(result.filter, /F_PARA_SaleSubProId\.FNumber LIKE '%QC-JE%'/);
  assert.equal(result.accepted.minimumDays, 180);
  assert.equal(result.accepted.cutoffDate, "2026-02-14");
});

test("builds the aging cutoff exclusively on sales invoice date", () => {
  const filter = buildOverdueInvoiceFilter("2026-02-14", ["SP-001", "SP'002"]);
  assert.match(filter, /FINVOICEDATE<'2026-02-14'/);
  assert.match(filter, /F_PARA_SaleSubProId\.FNumber IN \('SP-001','SP''002'\)/);
  assert.doesNotMatch(filter, /FDate|FEndDate/);
});

test("rejects invalid overdue day thresholds", () => {
  assert.throws(() => buildOverdueReceivableFilter({ minimumDays: 0 }, "2026-08-13"), /1 到 3650/);
  assert.throws(() => buildOverdueReceivableFilter({ minimumDays: "180.5" }, "2026-08-13"), /1 到 3650/);
});

test("aggregates one row per sales subproject from an invoice date", () => {
  const source = [
    { 应收内码: 1, 应收单号: "AR1", 客户: "客户甲", 销售子项目编码: "SP-1", 销售子项目名称: "销售子项目一", 已开票金额: 100, 已收金额: 0, 未收金额: 100, 已核销金额: 0 },
    { 应收内码: 2, 应收单号: "AR2", 客户: "客户甲", 销售子项目编码: "SP-1", 销售子项目名称: "销售子项目一", 已开票金额: 50, 已收金额: 30, 未收金额: 70, 已核销金额: 30 },
    { 应收内码: 3, 应收单号: "AR3", 客户: "客户乙", 销售子项目编码: "SP-2", 销售子项目名称: "销售子项目二", 已开票金额: 200, 已收金额: 0, 未收金额: 260, 已核销金额: 0 },
    { 应收内码: 4, 应收单号: "AR4", 客户: "客户丙", 销售子项目编码: "SP-3", 销售子项目名称: "已结清子项目", 已开票金额: 300, 已收金额: 300, 未收金额: 0, 已核销金额: 300 },
  ];
  const invoiceRows = [
    { 销售发票号: "INV1", 开票日期: "2026-01-10T00:00:00", 销售子项目编码: "SP-1", 销售子项目名称: "销售子项目一", 客户: "客户甲", 发票金额: 100 },
    { 销售发票号: "INV2", 开票日期: "2026-02-01T00:00:00", 销售子项目编码: "sp-1", 销售子项目名称: "销售子项目一", 客户: "客户甲", 发票金额: 50 },
    { 销售发票号: "INV3", 开票日期: "2026-01-05T00:00:00", 销售子项目编码: "SP-3", 销售子项目名称: "已结清子项目", 客户: "客户丙", 发票金额: 300 },
    { 销售发票号: "INV4", 开票日期: "2026-01-06T00:00:00", 销售子项目编码: "SP-4", 销售子项目名称: "没有应收的发票", 客户: "客户丁", 发票金额: 80 },
  ];
  const result = aggregateOverdueReceivables(source, {
    invoiceRows,
    receiptRows: [{ 销售子项目编码: "SP-1", 销售子项目名称: "销售子项目一", 收款金额: 150 }, { 销售子项目编码: "SP-4", 销售子项目名称: "没有应收的发票", 收款金额: 20 }],
    refundRows: [{ 销售子项目编码: "SP-1", 销售子项目名称: "销售子项目一", 退款金额: 20 }],
    asOfDate: "2026-08-13",
    minimumDays: 180,
  });
  assert.equal(result.statistics.subprojectCount, 2);
  assert.equal(result.statistics.customerCount, 2);
  assert.equal(result.statistics.outstandingAmount, 120);
  assert.equal(result.statistics.actualReceiptAmount, 150);
  assert.equal(result.statistics.unreconciledAmount, 120);
  assert.equal(result.statistics.invoiceOnlyCount, 1);
  assert.equal(result.statistics.invoiceOnlyAmount, 80);
  assert.equal(result.statistics.missingInvoiceDateSubprojects, 1);
  assert.equal(result.statistics.completelyUnpaidCount, 0);
  assert.equal(result.statistics.partiallyPaidCount, 1);
  assert.equal(result.rows[0]["销售子项目编码"], "SP-1");
  assert.equal(result.rows[0]["销售子项目名称"], "销售子项目一");
  assert.equal(result.rows[0]["开票日期"], "2026-01-10");
  assert.equal(result.rows[0]["超期发票数"], 2);
  assert.equal(result.rows[0]["应收单数"], 2);
  assert.equal(result.rows[0]["实际回款净额"], 130);
  assert.equal(result.rows[0]["未核销金额"], 100);
  assert.equal(result.rows[0]["未生成应收金额"], 0);
  assert.equal(result.rows[0]["未回款金额"], 120);
  assert.equal(result.rows[0]["到期日"], undefined);
  assert.equal(result.rows.some((row) => row["销售子项目编码"] === "SP-3"), false);
  assert.equal(result.rows.some((row) => row["销售子项目编码"] === "SP-4" && row["回款状态"] === "发票未生成应收"), true);
});

test("executes the overdue receivable tool with current business date and visible row limit", async () => {
  const requests = [];
  const kingdee = { executeBillQuery: async (username, payload) => {
    assert.equal(username, "240001");
    requests.push(payload);
    if (payload.FormId === "IV_SALESIC") return [["INV1", "2026-01-10T00:00:00", "SP-1", "销售子项目一", "客户甲", 100]];
    if (payload.FormId === "AR_RECEIVABLE") return [[1, "AR1", "客户甲", "湖南承希科技有限公司", "销售部", "SP-1", "销售子项目一", 100, 0, 100, 0]];
    if (payload.FormId === "AR_RECEIVEBILL") return [[10, "RC1", "2026-03-01T00:00:00", "SP-1", "销售子项目一", 80]];
    return [[20, "RF1", "2026-03-02T00:00:00", "SP-1", "销售子项目一", 5]];
  } };
  const engine = new QueryEngine({
    catalog,
    kingdee,
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 100, aggregationMaxRows: 5000 } },
    now: () => new Date("2026-08-13T03:00:00Z"),
  });
  const result = await engine.execute(identity, { tool: "overdue_receivables", arguments: { minimumDays: 180, limit: 1 } });
  assert.equal(requests.length, 5);
  assert.equal(requests[0].FormId, "IV_SALESIC");
  assert.match(requests[0].FilterString, /FINVOICEDATE<'2026-02-14'/);
  assert.equal(requests[0].Limit, 5001);
  assert.equal(requests[1].FormId, "IV_SALESIC");
  assert.match(requests[1].FilterString, /F_PARA_SaleSubProId\.FNumber IN \('SP-1'\)/);
  assert.equal(requests[2].FormId, "AR_RECEIVABLE");
  assert.doesNotMatch(requests[2].FilterString, /FDate|FEndDate/);
  assert.equal(requests[2].Limit, 5001);
  assert.equal(requests[3].FormId, "AR_RECEIVEBILL");
  assert.equal(requests[4].FormId, "AR_REFUNDBILL");
  assert.equal(result.count, 1);
  assert.equal(result.statistics.outstandingAmount, 100);
  assert.equal(result.statistics.actualReceiptAmount, 75);
  assert.equal(result.statistics.unreconciledAmount, 75);
  assert.equal(result.rows[0]["销售子项目编码"], "SP-1");
  assert.equal(result.rows[0]["开票日期"], "2026-01-10");
  assert.equal(result.rows[0]["回款状态"], "部分回款未结清");
});
