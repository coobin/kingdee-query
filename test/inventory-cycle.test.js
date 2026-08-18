const test = require("node:test");
const assert = require("node:assert/strict");
const { buildInventoryCycleResult } = require("../src/inventory-cycle");
const { QueryEngine } = require("../src/query-engine");
const catalog = require("../config/query-catalog.json");

const warehouseRows = [
  { "仓库编码": "CK255", "仓库名称": "项目仓-湖南承希-测试项目", "销售项目编码": "P1", "销售项目名称": "测试项目", "销售子项目编码": "SP1", "销售子项目名称": "测试子项目" },
  { "仓库编码": "KHCK002", "仓库名称": "客户仓-湖南承希-测试项目", "销售项目编码": "P1", "销售项目名称": "测试项目", "销售子项目编码": "SP1", "销售子项目名称": "测试子项目" },
];

test("calculates project age and customer pending-signoff age from the same receipt layer", () => {
  const result = buildInventoryCycleResult({
    warehouseRows,
    inventoryRows: [{ "仓库编码": "KHCK002", "物料编码": "M1", "物料名称": "设备", "批号": "L1", "基本库存数量": 5 }],
    inboundRows: [{ "仓库编码": "CK255", "物料编码": "M1", "物料名称": "设备", "批号": "L1", "基本入库数量": 5, "日期": "2025-03-06", "单据编号": "IN1", "销售子项目编码": "SP1", "销售子项目名称": "测试子项目" }],
    transferRows: [{ "单据编号": "TR1", "日期": "2025-05-24", "源单编号": "SO1", "调出仓库编码": "CK255", "调入仓库编码": "KHCK002", "物料编码": "M1", "物料名称": "设备", "调出批号": "L1", "调入批号": "L1", "调拨基本数量": 5, "销售子项目编码": "SP1", "销售子项目名称": "测试子项目" }],
    signoffRows: [],
    asOfDate: "2025-05-29",
    args: { materialNumber: "M1", warehouseScope: "customer" },
    limit: 200,
  });
  assert.equal(result.count, 1);
  assert.equal(result.rows[0]["项目仓库龄"], 79);
  assert.equal(result.rows[0]["客户仓待签收"], 5);
  assert.equal(result.rows[0]["总库存周期"], 84);
  assert.equal(result.rows[0]["状态"], "客户仓待签收");
});

test("excludes signed quantity while leaving a partial customer quantity pending", () => {
  const result = buildInventoryCycleResult({
    warehouseRows,
    inventoryRows: [{ "仓库编码": "KHCK002", "物料编码": "M1", "物料名称": "设备", "批号": "L1", "基本库存数量": 2 }],
    inboundRows: [{ "仓库编码": "CK255", "物料编码": "M1", "物料名称": "设备", "批号": "L1", "基本入库数量": 5, "日期": "2025-03-06", "单据编号": "IN1", "销售子项目编码": "SP1", "销售子项目名称": "测试子项目" }],
    transferRows: [{ "单据编号": "TR1", "日期": "2025-05-24", "源单编号": "SO1", "调出仓库编码": "CK255", "调入仓库编码": "KHCK002", "物料编码": "M1", "物料名称": "设备", "调出批号": "L1", "调入批号": "L1", "调拨基本数量": 5, "销售子项目编码": "SP1", "销售子项目名称": "测试子项目" }],
    signoffRows: [{ "单据编号": "SIGN1", "日期": "2025-05-27", "源单编号": "SO1", "仓库编码": "KHCK002", "物料编码": "M1", "物料名称": "设备", "批号": "L1", "签收基本数量": 3, "销售子项目编码": "SP1", "销售子项目名称": "测试子项目" }],
    asOfDate: "2025-05-29",
    args: { materialNumber: "M1", warehouseScope: "customer" },
    limit: 200,
  });
  assert.equal(result.count, 1);
  assert.equal(result.rows[0]["当前库存数量"], 2);
  assert.equal(result.statistics.signoffSourceCount, 1);
  assert.equal(result.rows[0]["客户签收单"], "");
});

test("queries the validated warehouse and three document sources", async () => {
  const requests = [];
  const kingdee = { executeBillQuery: async (username, request) => {
    assert.equal(username, "240001");
    requests.push(request);
    if (request.FormId === "BD_STOCK") return [["CK255", "项目仓-湖南承希-测试项目", "P1", "测试项目", "SP1", "测试子项目", "A"], ["KHCK002", "客户仓-湖南承希-测试项目", "P1", "测试项目", "SP1", "测试子项目", "A"]];
    if (request.FormId === "STK_Inventory") return [["KHCK002", "客户仓-湖南承希-测试项目", "M1", "设备", "L1", 5, ""]];
    if (request.FormId === "STK_InStock") return [["IN1", "2025-03-06T00:00:00", "C", "A", "M1", "设备", "CK255", "项目仓-湖南承希-测试项目", 5, "L1", "", "SP1", "测试子项目", "PUR1"]];
    if (request.FormId === "STK_TransferDirect") return [["TR1", "2025-05-24T00:00:00", "C", "A", "M1", "设备", "CK255", "项目仓-湖南承希-测试项目", "KHCK002", "客户仓-湖南承希-测试项目", 5, "L1", "L1", "", "2025-05-24T00:00:00", "SP1", "测试子项目", "SO1"]];
    if (request.FormId === "SAL_OUTSTOCK") return [];
    throw new Error(`unexpected form ${request.FormId}`);
  } };
  const engine = new QueryEngine({
    catalog,
    kingdee,
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 200, queryPageSize: 5000, aggregationMaxRows: 5000 } },
    now: () => new Date("2025-05-29T03:00:00Z"),
  });
  const result = await engine.execute({ kingdeeUsername: "240001", name: "张三" }, { tool: "inventory_cycle", arguments: { materialNumber: "M1", warehouseScope: "customer", limit: 100 } });
  assert.equal(result.rows[0]["总库存周期"], 84);
  assert.deepEqual(requests.map((request) => request.FormId), ["BD_STOCK", "STK_Inventory", "STK_InStock", "STK_TransferDirect", "SAL_OUTSTOCK"]);
  assert.match(requests[2].FilterString, /FStockId\.FNumber IN/);
  assert.match(requests[3].FilterString, /FSrcStockId\.FNumber IN/);
});
