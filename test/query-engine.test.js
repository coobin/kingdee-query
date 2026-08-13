const test = require("node:test");
const assert = require("node:assert/strict");
const {
  QueryEngine,
  buildFilter,
  rowsToObjects,
  escapeValue,
  buildOverdueReceivableFilter,
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
  const result = buildOverdueReceivableFilter({ minimumDays: 180, customerName: "客户'甲", projectNumber: "QC-JE" }, "2026-08-13");
  assert.match(result.filter, /FDate<'2026-02-14'/);
  assert.match(result.filter, /FDocumentStatus='C'/);
  assert.match(result.filter, /FIVALLAMOUNTFOR>0/);
  assert.match(result.filter, /FNORECEIVEAMOUNT>0/);
  assert.match(result.filter, /客户''甲/);
  assert.equal(result.accepted.minimumDays, 180);
  assert.equal(result.accepted.cutoffDate, "2026-02-14");
});

test("rejects invalid overdue day thresholds", () => {
  assert.throws(() => buildOverdueReceivableFilter({ minimumDays: 0 }, "2026-08-13"), /1 到 3650/);
  assert.throws(() => buildOverdueReceivableFilter({ minimumDays: "180.5" }, "2026-08-13"), /1 到 3650/);
});

test("aggregates invoiced exposure without counting unbilled balances", () => {
  const source = [
    { 应收内码: 1, 应收单号: "AR1", 应收日期: "2026-01-01T00:00:00", 到期日: "2026-01-31T00:00:00", 客户: "客户甲", 项目编号: "P1", 项目名称: "项目一", 子项目编号: "P1-1", 已开票金额: 100, 已收金额: 0, 未收金额: 100 },
    { 应收内码: 1, 应收单号: "AR1", 应收日期: "2026-01-01T00:00:00", 到期日: "2026-01-31T00:00:00", 客户: "客户甲", 项目编号: "P1", 项目名称: "项目一", 子项目编号: "P1-1", 已开票金额: 50, 已收金额: 30, 未收金额: 70 },
    { 应收内码: 2, 应收单号: "AR2", 应收日期: "2025-01-01T00:00:00", 到期日: "2025-02-01T00:00:00", 客户: "客户乙", 项目编号: "P2", 项目名称: "项目二", 子项目编号: "P2-1", 已开票金额: 200, 已收金额: 0, 未收金额: 260 },
  ];
  const result = aggregateOverdueReceivables(source, { asOfDate: "2026-08-13", minimumDays: 180 });
  assert.equal(result.statistics.billCount, 2);
  assert.equal(result.statistics.customerCount, 2);
  assert.equal(result.statistics.outstandingAmount, 320);
  assert.equal(result.statistics.completelyUnpaidCount, 1);
  assert.equal(result.statistics.partiallyPaidCount, 1);
  assert.equal(result.rows.find((row) => row["应收单号"] === "AR2")["未回款金额"], 200);
});

test("executes the overdue receivable tool with current business date and visible row limit", async () => {
  let request;
  const kingdee = { executeBillQuery: async (username, payload) => {
    assert.equal(username, "240001");
    request = payload;
    return [[1, "AR1", "2026-01-01T00:00:00", "2026-01-31T00:00:00", "客户甲", "湖南承希科技有限公司", "销售部", "张三", "P1", "项目一", "P1-1", 100, 0, 100]];
  } };
  const engine = new QueryEngine({
    catalog,
    kingdee,
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 100, aggregationMaxRows: 5000 } },
    now: () => new Date("2026-08-13T03:00:00Z"),
  });
  const result = await engine.execute(identity, { tool: "overdue_receivables", arguments: { minimumDays: 180, limit: 1 } });
  assert.match(request.FilterString, /FDate<'2026-02-14'/);
  assert.equal(request.Limit, 5001);
  assert.equal(result.count, 1);
  assert.equal(result.statistics.outstandingAmount, 100);
  assert.equal(result.rows[0]["回款状态"], "完全未回款");
});
