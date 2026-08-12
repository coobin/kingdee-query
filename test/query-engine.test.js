const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFilter, rowsToObjects, escapeValue } = require("../src/query-engine");

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
