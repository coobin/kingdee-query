const test = require("node:test");
const assert = require("node:assert/strict");
const {
  QueryEngine,
  buildFilter,
  rowsToObjects,
  escapeValue,
  buildOverdueReceivableFilter,
  buildReceivableAgingCandidateFilter,
  buildOverdueInvoiceFilter,
  aggregateReceivableAging,
  aggregateOverdueRiskCombined,
  aggregateOverdueReceivables,
  workflowRows,
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

test("maps current workflow nodes and handlers to read-only columns", () => {
  assert.deepEqual(workflowRows({ Rows: [{
    BillNo: "FYBX20260803000026",
    FormId: "ER_ExpReimbursement",
    ProcessName: "费用报销单",
    CreatedTime: "2026-08-10T00:30:15.893",
    StatusName: "审批中",
    CurrentNodes: [{
      NodeName: "二级部门主管审核",
      ArrivalTime: "2026-08-10T00:30:17.177",
      Handlers: [{ Account: "240498", Name: "田凯" }],
    }],
  }] }), [{
    单据编号: "FYBX20260803000026",
    表单: "ER_ExpReimbursement",
    流程名称: "费用报销单",
    当前节点: "二级部门主管审核",
    当前处理人: "田凯",
    节点到达时间: "2026-08-10T00:30:17.177",
    发起时间: "2026-08-10T00:30:15.893",
    状态: "审批中",
  }]);
});

test("queries my workflows without requiring a bill number", async () => {
  const requests = [];
  const kingdee = { workflowProgress: async (username, method, args) => {
    assert.equal(username, "240001");
    assert.equal(method, "Company.K3.WebApi.WorkflowQuery.GetMyProgress,Company.K3.WebApi");
    requests.push(args);
    return { Rows: [{ BillNo: "BX001", CurrentNodes: [{ NodeName: "部门审核", Handlers: [{ Name: "李四" }] }] }] };
  } };
  const engine = new QueryEngine({
    catalog,
    kingdee,
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 100, workflowMethod: "Company.K3.WebApi.WorkflowQuery.GetMyProgress,Company.K3.WebApi" } },
  });
  const result = await engine.workflow(identity, { limit: 20 });
  assert.deepEqual(requests, [{ Scope: "Mine" }]);
  assert.equal(result.count, 1);
  assert.equal(result.rows[0].当前节点, "部门审核");
  assert.equal(result.rows[0].当前处理人, "李四");
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

test("builds an AR-date aging filter without requiring an invoice", () => {
  const result = buildReceivableAgingCandidateFilter({ minimumDays: 180, customerName: "客户'甲", subprojectNumber: "AR-SP" }, "2026-08-13");
  assert.match(result.filter, /FDate<'2026-02-14'/);
  assert.match(result.filter, /FNORECEIVEAMOUNT>0/);
  assert.match(result.filter, /FALLAMOUNTFOR<>0/);
  assert.doesNotMatch(result.filter, /FIVALLAMOUNTFOR/);
  assert.match(result.filter, /客户''甲/);
  assert.equal(result.accepted.cutoffDate, "2026-02-14");
});

test("aggregates overdue AR entries, including entries with no invoice", () => {
  const result = aggregateReceivableAging([
    { 应收单号: "AR1", 应收分录内码: 101, 应收日期: "2025-01-10T00:00:00", 客户: "客户甲", 销售子项目编码: "SP-AR", 销售子项目名称: "应收项目", 应收单总额: 1000, 已收金额: 60, 未收金额: 40 },
    { 应收单号: "AR1", 应收分录内码: 101, 应收日期: "2025-01-10T00:00:00", 客户: "客户甲", 销售子项目编码: "SP-AR", 销售子项目名称: "应收项目", 应收单总额: 1000, 已收金额: 60, 未收金额: 40 },
    { 应收单号: "AR2", 应收分录内码: 102, 应收日期: "2025-01-15T00:00:00", 客户: "客户甲", 销售子项目编码: "SP-AR", 销售子项目名称: "应收项目", 应收单总额: 1000, 已收金额: 0, 未收金额: 50 },
    { 应收单号: "AR3", 应收分录内码: 103, 应收日期: "2026-02-20T00:00:00", 客户: "客户甲", 销售子项目编码: "SP-AR", 销售子项目名称: "应收项目", 应收单总额: 1000, 已收金额: 0, 未收金额: 80 },
  ], {
    invoiceWriteoffRows: [
      { 来源单据号: "INV1", 目标单据号: "AR1", 目标分录内码: 101, 来源单据类型: "IV_SALESIC", 目标单据类型: "AR_receivable", 本次开票核销金额: 60 },
    ],
    paymentConditionRows: [{ 销售子项目编码: "SP-AR", 收款条件: "月结30天" }],
    asOfDate: "2026-08-13",
    minimumDays: 180,
  });
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], {
    客户: "客户甲",
    销售子项目编码: "SP-AR",
    销售子项目名称: "应收项目",
    应收账龄日期: "2025-01-10",
    应收超期天数: 580,
    应收单数: 2,
    应收金额: 150,
    应收已收款金额: 60,
    应收未收款金额: 90,
    应收未开票金额: 90,
    回款状态: "部分回款未结清",
    收款条件: "月结30天",
  });
  assert.equal(result.statistics.outstandingAmount, 90);
  assert.equal(result.statistics.unbilledAmount, 90);
});

test("paginates every page when querying a source", async () => {
  const requests = [];
  const kingdee = { executeBillQuery: async (username, payload) => {
    assert.equal(username, "240001");
    requests.push(payload);
    if (payload.StartRow === 0) return [["A"], ["B"]];
    if (payload.StartRow === 2) return [["C"]];
    throw new Error(`unexpected page start ${payload.StartRow}`);
  } };
  const engine = new QueryEngine({
    catalog,
    kingdee,
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 2, queryPageSize: 2, aggregationMaxRows: 5 } },
  });
  const rows = await engine.queryAllPages(identity, { FormId: "IV_SALESIC", FieldKeys: "FBillNo" }, 2);
  assert.deepEqual(rows, [["A"], ["B"], ["C"]]);
  assert.deepEqual(requests.map((request) => [request.StartRow, request.Limit]), [[0, 2], [2, 2]]);
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
    { 销售发票号: "INV2-RED", 开票日期: "2026-02-02T00:00:00", 销售子项目编码: "sp-1", 销售子项目名称: "销售子项目一", 客户: "客户甲", 发票金额: -20, 红蓝字标识: "1" },
    { 销售发票号: "INV3", 开票日期: "2026-01-05T00:00:00", 销售子项目编码: "SP-3", 销售子项目名称: "已结清子项目", 客户: "客户丙", 发票金额: 300 },
    { 销售发票号: "INV4", 开票日期: "2026-01-06T00:00:00", 销售子项目编码: "SP-4", 销售子项目名称: "没有应收的发票", 客户: "客户丁", 发票金额: 80 },
  ];
  const result = aggregateOverdueReceivables(source, {
    invoiceRows,
    receiptRows: [{ 销售子项目编码: "SP-1", 销售子项目名称: "销售子项目一", 收款金额: 150 }, { 销售子项目编码: "SP-4", 销售子项目名称: "没有应收的发票", 收款金额: 20 }],
    refundRows: [{ 销售子项目编码: "SP-1", 销售子项目名称: "销售子项目一", 退款金额: 20 }],
    paymentConditionRows: [{ 销售子项目编码: "SP-1", 销售子项目名称: "销售子项目一", 收款条件: "月结30天" }],
    asOfDate: "2026-08-13",
    minimumDays: 180,
  });
  assert.equal(result.statistics.subprojectCount, 2);
  assert.equal(result.statistics.customerCount, 2);
  assert.equal(result.statistics.receivableOutstandingAmount, 120);
  assert.equal(result.statistics.receivedAmount, 150);
  assert.equal(result.statistics.paymentUnreconciledAmount, 120);
  assert.equal(result.statistics.unpaidAmount, 60);
  assert.equal(result.statistics.invoiceOnlyCount, 1);
  assert.equal(result.statistics.invoiceOnlyAmount, 80);
  assert.equal(result.statistics.unreceiptedCount, 1);
  assert.equal(result.statistics.fullyUnreceiptedCount, 1);
  assert.equal(result.statistics.partiallyUnreceiptedCount, 0);
  assert.equal(result.statistics.missingInvoiceDateSubprojects, 1);
  assert.equal(result.statistics.completelyUnpaidCount, 0);
  assert.equal(result.statistics.partiallyPaidCount, 1);
  const sp1 = result.rows.find((row) => row["销售子项目编码"] === "SP-1");
  assert.equal(sp1["销售子项目名称"], "销售子项目一");
  assert.equal(sp1["收款条件"], "月结30天");
  assert.equal(sp1["开票日期"], "2026-01-10");
  assert.equal(sp1["开票金额"], 130);
  assert.equal(sp1["超期发票数"], 3);
  assert.equal(sp1["应收单数"], 2);
  assert.equal(sp1["已收款金额"], 130);
  assert.equal(sp1["收款未核销金额"], 100);
  assert.equal(sp1["未生成应收金额"], 0);
  assert.equal(sp1["应收未收款金额"], 120);
  assert.equal(sp1["未回款金额"], 0);
  assert.equal(sp1["到期日"], undefined);
  assert.equal(result.rows.some((row) => row["销售子项目编码"] === "SP-3"), false);
  assert.equal(result.rows.some((row) => row["销售子项目编码"] === "SP-4" && row["回款状态"] === "完全未形成应收"), true);
  const sp4 = result.rows.find((row) => row["销售子项目编码"] === "SP-4");
  assert.equal(sp4["未回款金额"], 60);
});

test("distinguishes a partially formed receivable from no receivable", () => {
  const result = aggregateOverdueReceivables([
    { 应收内码: 11, 应收单号: "AR-PART", 客户: "客户戊", 销售子项目编码: "SP-PART", 销售子项目名称: "部分应收项目", 已开票金额: 60, 已收金额: 0, 未收金额: 60, 已核销金额: 0 },
  ], {
    invoiceRows: [{ 销售发票号: "INV-PART", 开票日期: "2026-01-01T00:00:00", 销售子项目编码: "SP-PART", 销售子项目名称: "部分应收项目", 客户: "客户戊", 发票金额: 100 }],
    asOfDate: "2026-08-13",
    minimumDays: 180,
  });
  assert.equal(result.statistics.unreceiptedCount, 1);
  assert.equal(result.statistics.fullyUnreceiptedCount, 0);
  assert.equal(result.statistics.partiallyUnreceiptedCount, 1);
  assert.equal(result.rows[0]["回款状态"], "未完全形成应收");
  assert.equal(result.rows[0]["未生成应收金额"], 40);
  assert.equal(result.rows[0]["应收未收款金额"], 60);
  assert.equal(result.rows[0]["未回款金额"], 100);
});

test("calculates true unpaid amount from invoiced amount minus received amount", () => {
  const result = aggregateOverdueReceivables([
    { 应收内码: 31, 应收单号: "AR-BALANCED", 客户: "客户平衡", 销售子项目编码: "SP-BALANCED", 销售子项目名称: "平衡项目", 已开票金额: 80, 已收金额: 60, 未收金额: 20, 已核销金额: 60 },
  ], {
    invoiceRows: [{ 销售发票号: "INV-BALANCED", 开票日期: "2026-01-01T00:00:00", 销售子项目编码: "SP-BALANCED", 销售子项目名称: "平衡项目", 客户: "客户平衡", 发票金额: 100 }],
    receiptRows: [{ 销售子项目编码: "SP-BALANCED", 销售子项目名称: "平衡项目", 收款金额: 60 }],
    asOfDate: "2026-08-13",
    minimumDays: 180,
  });
  const row = result.rows[0];
  assert.equal(row["已收款金额"], 60);
  assert.equal(row["应收未收款金额"], 20);
  assert.equal(row["未生成应收金额"], 20);
  assert.equal(row["未回款金额"], 40);
  assert.equal(row["未回款金额"], row["应收未收款金额"] + row["未生成应收金额"]);
  assert.equal(row["开票金额"] - row["应收未收款金额"] - row["未生成应收金额"], row["已收款金额"]);
});

test("uses the earliest overdue invoice for aging date and count", () => {
  const result = aggregateOverdueReceivables([
    { 应收内码: 21, 应收单号: "AR-AGING", 客户: "客户己", 销售子项目编码: "SP-AGING", 销售子项目名称: "账龄项目", 已开票金额: 150, 已收金额: 0, 未收金额: 150, 已核销金额: 0 },
  ], {
    invoiceRows: [
      { 销售发票号: "INV-NOT-CANDIDATE", 开票日期: "2025-01-01T00:00:00", 销售子项目编码: "SP-AGING", 销售子项目名称: "账龄项目", 客户: "客户己", 发票金额: 100 },
      { 销售发票号: "INV-OVERDUE", 开票日期: "2026-01-10T00:00:00", 销售子项目编码: "SP-AGING", 销售子项目名称: "账龄项目", 客户: "客户己", 发票金额: 50 },
    ],
    overdueInvoiceRows: [
      { 销售发票号: "INV-OVERDUE", 开票日期: "2026-01-10T00:00:00", 销售子项目编码: "SP-AGING", 销售子项目名称: "账龄项目", 客户: "客户己", 发票金额: 50 },
    ],
    asOfDate: "2026-08-13",
    minimumDays: 180,
  });
  assert.equal(result.rows[0]["开票日期"], "2026-01-10");
  assert.equal(result.rows[0]["超期发票数"], 1);
  assert.equal(result.rows[0]["开票金额"], 150);
});

test("rejects a future invoice from the aging candidate set", () => {
  const result = aggregateOverdueReceivables([
    { 应收内码: 22, 应收单号: "AR-AGING-FILTER", 客户: "客户庚", 销售子项目编码: "SP-AGING-FILTER", 销售子项目名称: "账龄过滤项目", 已开票金额: 150, 已收金额: 0, 未收金额: 150, 已核销金额: 0 },
  ], {
    invoiceRows: [
      { 销售发票号: "INV-FUTURE", 开票日期: "2026-04-08T00:00:00", 销售子项目编码: "SP-AGING-FILTER", 销售子项目名称: "账龄过滤项目", 客户: "客户庚", 发票金额: 50 },
      { 销售发票号: "INV-OVERDUE-FILTER", 开票日期: "2025-11-19T00:00:00", 销售子项目编码: "SP-AGING-FILTER", 销售子项目名称: "账龄过滤项目", 客户: "客户庚", 发票金额: 100 },
    ],
    overdueInvoiceRows: [
      { 销售发票号: "INV-FUTURE", 开票日期: "2026-04-08T00:00:00", 销售子项目编码: "SP-AGING-FILTER", 销售子项目名称: "账龄过滤项目", 客户: "客户庚", 发票金额: 50 },
      { 销售发票号: "INV-OVERDUE-FILTER", 开票日期: "2025-11-19T00:00:00", 销售子项目编码: "SP-AGING-FILTER", 销售子项目名称: "账龄过滤项目", 客户: "客户庚", 发票金额: 100 },
    ],
    asOfDate: "2026-08-14",
    minimumDays: 180,
  });
  assert.equal(result.rows[0]["开票日期"], "2025-11-19");
  assert.equal(result.rows[0]["超期发票数"], 1);
});

test("uses invoice-to-receivable writeoff status for the overdue aging date", () => {
  const result = aggregateOverdueReceivables([
    { 应收内码: 1, 应收分录内码: 11, 应收单号: "AR-PAID", 客户: "客户甲", 销售子项目编码: "SP-STRICT", 销售子项目名称: "严格核销项目", 已开票金额: 100, 已收金额: 80, 未收金额: 20, 已核销金额: 80 },
    { 应收内码: 2, 应收分录内码: 12, 应收单号: "AR-UNPAID", 客户: "客户甲", 销售子项目编码: "SP-STRICT", 销售子项目名称: "严格核销项目", 已开票金额: 80, 已收金额: 0, 未收金额: 80, 已核销金额: 0 },
  ], {
    invoiceRows: [
      { 销售发票号: "INV-PAID", 销售发票分录内码: 101, 开票日期: "2025-11-19T00:00:00", 销售子项目编码: "SP-STRICT", 销售子项目名称: "严格核销项目", 客户: "客户甲", 发票金额: 100 },
      { 销售发票号: "INV-UNPAID", 销售发票分录内码: 102, 开票日期: "2025-12-04T00:00:00", 销售子项目编码: "SP-STRICT", 销售子项目名称: "严格核销项目", 客户: "客户甲", 发票金额: 80 },
      { 销售发票号: "INV-FUTURE", 销售发票分录内码: 103, 开票日期: "2026-04-08T00:00:00", 销售子项目编码: "SP-STRICT", 销售子项目名称: "严格核销项目", 客户: "客户甲", 发票金额: 50 },
    ],
    overdueInvoiceRows: [
      { 销售发票号: "INV-PAID", 开票日期: "2025-11-19T00:00:00", 销售子项目编码: "SP-STRICT", 销售子项目名称: "严格核销项目", 客户: "客户甲", 发票金额: 100 },
      { 销售发票号: "INV-UNPAID", 开票日期: "2025-12-04T00:00:00", 销售子项目编码: "SP-STRICT", 销售子项目名称: "严格核销项目", 客户: "客户甲", 发票金额: 80 },
    ],
    invoiceWriteoffRows: [
      { 核销记录号: "BM-PAID", 来源单据号: "INV-PAID", 来源分录内码: 101, 目标单据号: "AR-PAID", 目标分录内码: 11, 来源单据类型: "IV_SALESIC", 目标单据类型: "AR_receivable", 本次开票核销金额: 100 },
      { 核销记录号: "BM-UNPAID", 来源单据号: "INV-UNPAID", 来源分录内码: 102, 目标单据号: "AR-UNPAID", 目标分录内码: 12, 来源单据类型: "IV_SALESIC", 目标单据类型: "AR_receivable", 本次开票核销金额: 80 },
    ],
    receiptWriteoffRows: [
      { 来源单据号: "AR-PAID", 目标单据号: "RC-PAID", 来源单据类型: "AR_receivable", 目标单据类型: "AR_RECEIVEBILL", 未收款核销金额: 0 },
    ],
    asOfDate: "2026-08-14",
    minimumDays: 180,
  });
  assert.equal(result.rows[0]["开票日期"], "2025-11-19");
  assert.equal(result.rows[0]["超期发票数"], 2);
  assert.equal(result.rows[0]["应收未收款金额"], 80);
  assert.equal(result.rows[0]["已收款金额"], 100);
  assert.equal(result.rows[0]["未回款金额"], 80);
  assert.equal(result.rows[0]["未生成应收金额"], 0);
  assert.equal(result.rows[0]["开票金额"], 180);
});

test("counts an old invoice without an invoice-to-receivable match as unformed", () => {
  const result = aggregateOverdueReceivables([], {
    invoiceRows: [{ 销售发票号: "INV-NO-AR", 销售发票分录内码: 201, 开票日期: "2025-11-19T00:00:00", 销售子项目编码: "SP-NO-AR", 销售子项目名称: "未形成应收项目", 客户: "客户乙", 发票金额: 60 }],
    overdueInvoiceRows: [{ 销售发票号: "INV-NO-AR", 开票日期: "2025-11-19T00:00:00", 销售子项目编码: "SP-NO-AR", 销售子项目名称: "未形成应收项目", 客户: "客户乙", 发票金额: 60 }],
    invoiceWriteoffRows: [],
    asOfDate: "2026-08-14",
    minimumDays: 180,
  });
  assert.equal(result.rows[0]["回款状态"], "完全未形成应收");
  assert.equal(result.rows[0]["未生成应收金额"], 60);
  assert.equal(result.rows[0]["应收未收款金额"], 0);
  assert.equal(result.rows[0]["未回款金额"], 60);
  assert.equal(result.rows[0]["超期发票数"], 1);
});

test("nets red and blue invoices before calculating unformed receivables", () => {
  const result = aggregateOverdueReceivables([
    { 应收内码: 41, 应收分录内码: 401, 应收单号: "AR-RED-BLUE", 客户: "客户丙", 销售子项目编码: "SP-RED-BLUE", 销售子项目名称: "红蓝字项目", 已开票金额: 80, 已收金额: 20, 未收金额: 60, 已核销金额: 20 },
  ], {
    invoiceRows: [
      { 销售发票号: "INV-BLUE-OLD", 开票日期: "2025-11-19T00:00:00", 销售子项目编码: "SP-RED-BLUE", 销售子项目名称: "红蓝字项目", 客户: "客户丙", 发票金额: 100, 红蓝字标识: "0" },
      { 销售发票号: "INV-RED-REVERSAL", 开票日期: "2025-12-01T00:00:00", 销售子项目编码: "SP-RED-BLUE", 销售子项目名称: "红蓝字项目", 客户: "客户丙", 发票金额: 100, 红蓝字标识: "1" },
      { 销售发票号: "INV-CURRENT", 开票日期: "2026-01-05T00:00:00", 销售子项目编码: "SP-RED-BLUE", 销售子项目名称: "红蓝字项目", 客户: "客户丙", 发票金额: 80, 红蓝字标识: "0" },
    ],
    overdueInvoiceRows: [
      { 销售发票号: "INV-BLUE-OLD", 开票日期: "2025-11-19T00:00:00", 销售子项目编码: "SP-RED-BLUE", 销售子项目名称: "红蓝字项目", 客户: "客户丙", 发票金额: 100, 红蓝字标识: "0" },
      { 销售发票号: "INV-RED-REVERSAL", 开票日期: "2025-12-01T00:00:00", 销售子项目编码: "SP-RED-BLUE", 销售子项目名称: "红蓝字项目", 客户: "客户丙", 发票金额: 100, 红蓝字标识: "1" },
      { 销售发票号: "INV-CURRENT", 开票日期: "2026-01-05T00:00:00", 销售子项目编码: "SP-RED-BLUE", 销售子项目名称: "红蓝字项目", 客户: "客户丙", 发票金额: 80, 红蓝字标识: "0" },
    ],
    invoiceWriteoffRows: [
      { 核销记录号: "BM-CURRENT", 来源单据号: "INV-CURRENT", 来源分录内码: 403, 目标单据号: "AR-RED-BLUE", 目标分录内码: 401, 来源单据类型: "IV_SALESIC", 目标单据类型: "AR_receivable", 本次开票核销金额: 80 },
    ],
    asOfDate: "2026-08-14",
    minimumDays: 180,
  });
  const row = result.rows[0];
  assert.equal(row["开票金额"], 80);
  assert.equal(row["未生成应收金额"], 0);
  assert.equal(row["应收未收款金额"], 60);
  assert.equal(row["已收款金额"], 20);
  assert.equal(row["未回款金额"], 60);
  assert.equal(row["未回款金额"], row["未生成应收金额"] + row["应收未收款金额"]);
});

test("executes the overdue receivable tool with current business date and visible row limit", async () => {
  const requests = [];
  const kingdee = { executeBillQuery: async (username, payload) => {
    assert.equal(username, "240001");
    requests.push(payload);
    if (payload.FormId === "IV_SALESIC") return [[101, "INV1", 1001, "2026-01-10T00:00:00", "SP-1", "销售子项目一", "客户甲", 100, "0"]];
    if (payload.FormId === "AR_RECEIVABLE") return [[1, 2001, "AR1", "客户甲", "湖南承希科技有限公司", "销售部", "SP-1", "销售子项目一", 100, 75, 25, 75]];
    if (payload.FormId === "AR_MATCHRECORD") return [];
    if (payload.FormId === "AR_BILLINGMATCHRECORD") return [["BM1", "2026-03-01", "INV1", 1001, "AR1", 2001, "IV_SALESIC", "AR_receivable", 100, 100, 0, "SP-1"]];
    if (payload.FormId === "AR_RECEIVEBILL") return [[10, "RC1", "2026-03-01T00:00:00", "SP-1", "销售子项目一", 80]];
    if (payload.FormId === "AR_REFUNDBILL") return [[20, "RF1", "2026-03-02T00:00:00", "SP-1", "销售子项目一", 5]];
    if (payload.FormId === "PARA_SaleSubProject") return [["SP-1", "销售子项目一", "月结30天"]];
    throw new Error(`unexpected form ${payload.FormId}`);
  } };
  const engine = new QueryEngine({
    catalog,
    kingdee,
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 100, queryPageSize: 5000, aggregationMaxRows: 5000 } },
    now: () => new Date("2026-08-13T03:00:00Z"),
  });
  const result = await engine.execute(identity, { tool: "overdue_receivables", arguments: { minimumDays: 180, limit: 1 } });
  assert.equal(requests.length, 8);
  assert.equal(requests[0].FormId, "IV_SALESIC");
  assert.match(requests[0].FilterString, /FINVOICEDATE<'2026-02-14'/);
  assert.equal(requests[0].Limit, 5000);
  assert.equal(requests[1].FormId, "IV_SALESIC");
  assert.match(requests[1].FilterString, /F_PARA_SaleSubProId\.FNumber IN \('SP-1'\)/);
  assert.equal(requests[2].FormId, "AR_RECEIVABLE");
  assert.doesNotMatch(requests[2].FilterString, /FDate|FEndDate/);
  assert.equal(requests[2].Limit, 5000);
  assert.equal(requests[3].FormId, "AR_MATCHRECORD");
  assert.match(requests[3].FilterString, /FSRCBILLNO IN \('AR1'\)/);
  assert.equal(requests[4].FormId, "AR_BILLINGMATCHRECORD");
  assert.equal(requests[5].FormId, "AR_RECEIVEBILL");
  assert.equal(requests[6].FormId, "AR_REFUNDBILL");
  assert.equal(requests[7].FormId, "PARA_SaleSubProject");
  assert.equal(requests[7].FieldKeys, "FBillNo,FName,FRecConditionStr");
  assert.equal(requests[7].FilterString, "FBillNo IN ('SP-1')");
  assert.equal(result.count, 1);
  assert.equal(result.columns.at(-1), "收款条件");
  assert.equal(result.statistics.receivableOutstandingAmount, 25);
  assert.equal(result.statistics.receivedAmount, 75);
  assert.equal(result.statistics.paymentUnreconciledAmount, 0);
  assert.equal(result.statistics.unpaidAmount, 25);
  assert.equal(result.rows[0]["销售子项目编码"], "SP-1");
  assert.equal(result.rows[0]["收款条件"], "月结30天");
  assert.equal(result.rows[0]["开票日期"], "2026-01-10");
  assert.equal(result.rows[0]["回款状态"], "部分回款未结清");
  assert.equal(result.rows[0]["已收款金额"], 75);
  assert.equal(result.rows[0]["应收未收款金额"], 25);
  assert.equal(result.rows[0]["未回款金额"], 25);
});

test("executes the independent AR aging tool and keeps unbilled AR in scope", async () => {
  const requests = [];
  const kingdee = { executeBillQuery: async (username, payload) => {
    assert.equal(username, "240001");
    requests.push(payload);
    if (payload.FormId === "AR_RECEIVABLE") return [[1, 2001, "AR1", "2025-01-10T00:00:00", "客户甲", "SP-1", "应收项目", 100, 60, 40]];
    if (payload.FormId === "AR_BILLINGMATCHRECORD") return [["BM1", "INV1", "AR1", 2001, "IV_SALESIC", "AR_receivable", 60, 60]];
    if (payload.FormId === "PARA_SaleSubProject") return [["SP-1", "月结30天"]];
    throw new Error(`unexpected form ${payload.FormId}`);
  } };
  const engine = new QueryEngine({
    catalog,
    kingdee,
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 100, queryPageSize: 5000, aggregationMaxRows: 5000 } },
    now: () => new Date("2026-08-13T03:00:00Z"),
  });
  const result = await engine.execute(identity, { tool: "receivable_aging", arguments: { minimumDays: 180, subprojectNumber: "SP-1", limit: 1 } });
  assert.equal(requests.length, 3);
  assert.equal(requests[0].FormId, "AR_RECEIVABLE");
  assert.match(requests[0].FilterString, /FDate<'2026-02-14'/);
  assert.match(requests[0].FilterString, /FNORECEIVEAMOUNT>0/);
  assert.equal(requests[1].FormId, "AR_BILLINGMATCHRECORD");
  assert.equal(requests[2].FormId, "PARA_SaleSubProject");
  assert.equal(result.tool, "receivable_aging");
  assert.equal(result.rows[0]["应收账龄日期"], "2025-01-10");
  assert.equal(result.rows[0]["应收已收款金额"], 60);
  assert.equal(result.rows[0]["应收未收款金额"], 40);
  assert.equal(result.rows[0]["应收未开票金额"], 40);
  assert.equal(result.rows[0]["收款条件"], "月结30天");
});

test("combines invoice and receivable risk by taking the larger amount", () => {
  const result = aggregateOverdueRiskCombined({
    query: { asOfDate: "2026-08-18" },
    truncated: false,
    rows: [
      { 客户: "客户甲", 销售子项目编码: "SP-1", 销售子项目名称: "项目一", 未回款金额: 100, 开票日期: "2025-01-01", 超期天数: 594, 超期发票数: 2, 未生成应收金额: 20, 回款状态: "未完全形成应收", 收款条件: "月结" },
      { 客户: "客户乙", 销售子项目编码: "SP-2", 销售子项目名称: "项目二", 未回款金额: 30, 开票日期: "2025-02-01", 超期天数: 563, 超期发票数: 1, 未生成应收金额: 0, 回款状态: "部分回款未结清", 收款条件: "现款" },
    ],
  }, {
    query: { asOfDate: "2026-08-18" },
    truncated: false,
    rows: [
      { 客户: "客户甲", 销售子项目编码: "SP-1", 销售子项目名称: "项目一", 应收未收款金额: 80, 应收账龄日期: "2025-03-01", 应收超期天数: 535, 应收单数: 2, 应收未开票金额: 40, 回款状态: "部分回款未结清", 收款条件: "月结" },
      { 客户: "客户丙", 销售子项目编码: "SP-3", 销售子项目名称: "项目三", 应收未收款金额: 200, 应收账龄日期: "2024-01-01", 应收超期天数: 961, 应收单数: 1, 应收未开票金额: 200, 回款状态: "完全未回款", 收款条件: "账期" },
    ],
  }, { invoiceDays: 180, receivableDays: 270 });
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows.find((row) => row["销售子项目编码"] === "SP-1")["采用口径"], "发票超期");
  assert.equal(result.rows.find((row) => row["销售子项目编码"] === "SP-1")["最终超期风险金额"], 100);
  assert.equal(result.rows.find((row) => row["销售子项目编码"] === "SP-3")["采用口径"], "应收超期");
  assert.equal(result.statistics.invoiceSelectedCount, 2);
  assert.equal(result.statistics.receivableSelectedCount, 1);
  assert.equal(result.statistics.finalRiskAmount, 330);
});

test("passes independent invoice and receivable day thresholds to the combined tool", async () => {
  const engine = new QueryEngine({
    catalog,
    kingdee: {},
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 100, queryPageSize: 5000, aggregationMaxRows: 5000 } },
  });
  engine.overdueReceivables = async (identity, item, args, options) => {
    assert.equal(args.minimumDays, 180);
    assert.equal(options.returnAll, true);
    return { query: { asOfDate: "2026-08-18" }, truncated: false, rows: [{ 客户: "客户甲", 销售子项目编码: "SP-1", 销售子项目名称: "项目一", 未回款金额: 100, 开票日期: "2025-01-01", 超期天数: 594, 超期发票数: 1, 未生成应收金额: 0, 回款状态: "部分回款未结清", 收款条件: "月结" }] };
  };
  engine.receivableAging = async (identity, item, args, options) => {
    assert.equal(args.minimumDays, 270);
    assert.equal(options.returnAll, true);
    return { query: { asOfDate: "2026-08-18" }, truncated: false, rows: [{ 客户: "客户甲", 销售子项目编码: "SP-1", 销售子项目名称: "项目一", 应收未收款金额: 80, 应收账龄日期: "2025-03-01", 应收超期天数: 535, 应收单数: 1, 应收未开票金额: 20, 回款状态: "部分回款未结清", 收款条件: "月结" }] };
  };
  const result = await engine.execute(identity, { tool: "overdue_risk_combined", arguments: { invoiceDays: 180, receivableDays: 270, limit: 1 } });
  assert.equal(result.query.invoiceDays, 180);
  assert.equal(result.query.receivableDays, 270);
  assert.equal(result.rows[0]["最终超期风险金额"], 100);
});

test("returns every combined risk row instead of applying the ordinary row limit", async () => {
  const engine = new QueryEngine({
    catalog,
    kingdee: {},
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 1, queryPageSize: 5000, aggregationMaxRows: 5000 } },
  });
  engine.overdueReceivables = async (identity, item, args, options) => {
    assert.equal(options.returnAll, true);
    return { query: { asOfDate: "2026-08-18" }, truncated: false, rows: [
      { 客户: "客户甲", 销售子项目编码: "SP-1", 销售子项目名称: "项目一", 未回款金额: 100, 开票日期: "2025-01-01", 超期天数: 594, 超期发票数: 1, 未生成应收金额: 0, 回款状态: "部分回款未结清", 收款条件: "月结" },
      { 客户: "客户乙", 销售子项目编码: "SP-2", 销售子项目名称: "项目二", 未回款金额: 80, 开票日期: "2025-02-01", 超期天数: 563, 超期发票数: 1, 未生成应收金额: 0, 回款状态: "完全未回款", 收款条件: "现款" },
    ] };
  };
  engine.receivableAging = async (identity, item, args, options) => {
    assert.equal(options.returnAll, true);
    return { query: { asOfDate: "2026-08-18" }, truncated: false, rows: [] };
  };
  const result = await engine.execute(identity, { tool: "overdue_risk_combined", arguments: { invoiceDays: 180, receivableDays: 270, limit: 1 } });
  assert.equal(result.rows.length, 2);
  assert.equal(result.count, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.statistics.partial, false);
});

test("keeps the list date tied to the overdue invoice query, not the full invoice query", async () => {
  const kingdee = { executeBillQuery: async (username, payload) => {
    assert.equal(username, "240001");
    if (payload.FormId === "IV_SALESIC") {
      if (payload.FilterString.includes("FINVOICEDATE<")) {
        return [[102, "INV-OVERDUE", 1002, "2026-01-10T00:00:00", "SP-DATE", "日期项目", "客户", 100, "0"]];
      }
      return [
        [102, "INV-OLDER", 1003, "2025-01-01T00:00:00", "SP-DATE", "日期项目", "客户", 50, "0"],
        [102, "INV-OVERDUE", 1002, "2026-01-10T00:00:00", "SP-DATE", "日期项目", "客户", 100, "0"],
      ];
    }
    if (payload.FormId === "AR_RECEIVABLE") return [[1, 2002, "AR-DATE", "客户", "组织", "部门", "SP-DATE", "日期项目", 150, 0, 150, 0]];
    if (payload.FormId === "AR_MATCHRECORD" || payload.FormId === "AR_BILLINGMATCHRECORD") return [];
    if (payload.FormId === "PARA_SaleSubProject") return [];
    if (payload.FormId === "AR_RECEIVEBILL" || payload.FormId === "AR_REFUNDBILL") return [];
    throw new Error(`unexpected form ${payload.FormId}`);
  } };
  const engine = new QueryEngine({
    catalog,
    kingdee,
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 100, queryPageSize: 5000, aggregationMaxRows: 5000 } },
    now: () => new Date("2026-08-13T03:00:00Z"),
  });
  const result = await engine.execute(identity, { tool: "overdue_receivables", arguments: { minimumDays: 180, subprojectNumber: "SP-DATE", limit: 1 } });
  assert.equal(result.rows[0]["开票日期"], "2026-01-10");
  assert.equal(result.rows[0]["超期发票数"], 1);
});
