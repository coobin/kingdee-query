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
  personnelCostDateRange,
  buildPersonnelCostFilters,
  aggregatePersonnelCost,
  mapExpenseDetailRows,
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

test("queries the original project purchase-sales report with resolved base data", async () => {
  const requests = [];
  const reportRequests = [];
  const kingdee = {
    executeBillQuery: async (username, request) => {
      assert.equal(username, "240001");
      requests.push(request);
      const rows = {
        ORG_Organizations: [[1, "ORG001", "示例组织"]],
        PARA_ProjectView: [[101, "P-001", "示例项目"]],
        PARA_SaleSubProject: [[102, "SP-001", "示例子项目"]],
        BD_Department: [[103, "D-001", "示例部门", "ORG001"]],
        BD_Customer: [[104, "C-001", "示例客户", "ORG001"]],
      };
      return rows[request.FormId] || [];
    },
    getSysReportData: async (username, formId, data) => {
      assert.equal(username, "240001");
      assert.equal(formId, "PARA_PM_ProjectPurSaleRpt");
      reportRequests.push(data);
      return { IsSuccess: true, RowCount: 8, Rows: [["ORG001", "P-001", "SP-001"]] };
    },
  };
  const engine = new QueryEngine({
    catalog,
    kingdee,
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 200 } },
  });
  const result = await engine.execute(identity, {
    tool: "project_pur_sale_consistency",
    arguments: {
      organizationNumber: "ORG001",
      projectNumber: "P-001",
      subprojectNumber: "SP-001",
      departmentNumber: "D-001",
      customerNumber: "C-001",
      dateFrom: "2021-11-23",
      dateTo: "2022-12-31",
      limit: 1,
    },
  });
  assert.equal(requests.length, 5);
  assert.equal(reportRequests.length, 1);
  assert.equal(reportRequests[0].FilterString, "");
  assert.equal(reportRequests[0].Limit, 1);
  assert.deepEqual(reportRequests[0].Model, {
    FOrgId: { Id: 1, FNumber: "ORG001", FName: "示例组织" },
    FSaleProjectId: { Id: 101, FNumber: "P-001", FName: "示例项目" },
    FSaleSuProjectId: { Id: 102, FNumber: "SP-001", FName: "示例子项目" },
    FSaleDeptId: { Id: 103, FNumber: "D-001", FName: "示例部门" },
    FCustId: { Id: 104, FNumber: "C-001", FName: "示例客户" },
    FContractStartDate: "2021-11-23",
    FContractEndDate: "2022-12-31",
  });
  assert.equal(result.count, 8);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.columns, catalog.project_pur_sale_consistency.fields.map(([, label]) => label));
  assert.equal(result.rows[0]["组织"], "ORG001");
});

test("maps document status codes to readable Chinese labels", () => {
  const fields = [["FBillNo", "单据编号"], ["FDocumentStatus", "审核状态"]];
  const mappings = { 审核状态: { A: "已创建", B: "审核中", C: "已审核" } };
  assert.deepEqual(rowsToObjects([["BX001", "C"]], fields, mappings), [{ 单据编号: "BX001", 审核状态: "已审核" }]);
  assert.deepEqual(rowsToObjects([["BX002", "X"]], fields, mappings), [{ 单据编号: "BX002", 审核状态: "其他状态" }]);
});

test("maps expense entry fields without exposing internal or bank fields", () => {
  const source = catalog.expense_claims.detailSource;
  const rows = mapExpenseDetailRows([[
    101, "差旅费", "C", "销售部", "P001", "一号项目", "SP001", "一期",
    "2026-08-01T00:00:00", "2026-08-03T00:00:00", "客户现场", 280, 20, 300, 290, 90,
  ]], source);
  assert.deepEqual(rows, [{
    序号: 1,
    费用项目: "差旅费",
    报销类型: "差旅",
    费用承担部门: "销售部",
    销售项目: "P001 · 一号项目",
    销售子项目: "SP001 · 一期",
    费用日期: "2026-08-01 至 2026-08-03",
    备注: "客户现场",
    费用金额: 280,
    税额: 20,
    申请报销金额: 300,
    核定报销金额: 290,
    未付款金额: 90,
  }]);
  assert.equal("明细内码" in rows[0], false);
  assert.equal(source.fields.some(([field]) => /bank|account/i.test(field)), false);
});

test("requires a bounded personnel cost date range", () => {
  assert.deepEqual(personnelCostDateRange({ dateFrom: "2026-07-01", dateTo: "2026-07-31" }), {
    dateFrom: "2026-07-01",
    dateTo: "2026-07-31",
    dateToExclusive: "2026-08-01",
    days: 31,
  });
  assert.throws(() => personnelCostDateRange({}), /必须填写/);
  assert.throws(() => personnelCostDateRange({ dateFrom: "2026-08-01", dateTo: "2026-07-31" }), /不能晚于/);
  assert.throws(() => personnelCostDateRange({ dateFrom: "2025-01-01", dateTo: "2026-01-02" }), /最多为 366 天/);
});

test("builds matching approved payroll and reimbursement filters", () => {
  const range = personnelCostDateRange({ dateFrom: "2026-07-01", dateTo: "2026-07-31" });
  const filters = buildPersonnelCostFilters({ employeeNumber: "24'001", employeeName: "张'三", departmentName: "研发" }, range);
  assert.match(filters.payroll, /FDocumentStatus='C'/);
  assert.match(filters.payroll, /FDate>='2026-07-01'/);
  assert.match(filters.payroll, /FDate<'2026-08-01'/);
  assert.match(filters.payroll, /FEmpInfoId\.FNumber='24''001'/);
  assert.match(filters.expense, /FProposerID\.FNumber='24''001'/);
  assert.match(filters.expense, /FProposerID\.FName LIKE '%张''三%'/);
  assert.match(filters.expense, /FRequestDeptID\.FName LIKE '%研发%'/);
  assert.match(filters.expense, /F_PARA_ExType<>'A'/);
});

test("aggregates personnel cost by employee number and keeps reimbursement-only people", () => {
  const range = personnelCostDateRange({ dateFrom: "2026-07-01", dateTo: "2026-07-31" });
  const result = aggregatePersonnelCost([
    { 工资单号: "P1", 工资日期: "2026-07-01", 员工编号: "001", 姓名: "甲", 所属部门: "研发", 工资币别: "PRE001", 实发工资: 1000.1 },
    { 工资单号: "P2", 工资日期: "2026-07-15", 员工编号: "001", 姓名: "甲", 所属部门: "研发", 工资币别: "PRE001", 实发工资: 199.9 },
    { 工资单号: "P3", 工资日期: "2026-07-01", 员工编号: "002", 姓名: "乙", 所属部门: "交付", 工资币别: "PRE001", 实发工资: 800 },
  ], [
    { 报销单号: "E1", 申请日期: "2026-07-10", 员工编号: "001", 姓名: "甲", 申请部门: "研发", 报销币别: "PRE001", 报销类型: "B", 核定报销金额: 60 },
    { 报销单号: "E1", 申请日期: "2026-07-10", 员工编号: "001", 姓名: "甲", 申请部门: "研发", 报销币别: "PRE001", 报销类型: "C", 核定报销金额: 40 },
    { 报销单号: "E2", 申请日期: "2026-07-11", 员工编号: "003", 姓名: "丙", 申请部门: "销售", 报销币别: "PRE001", 报销类型: "D", 核定报销金额: 300 },
    { 报销单号: "E3", 申请日期: "2026-07-12", 员工编号: "001", 姓名: "甲", 申请部门: "研发", 报销币别: "USD", 报销类型: "A", 核定报销金额: 500 },
  ], range);
  assert.deepEqual(result.rows.map((row) => [row.员工编号, row.人员成本, row.数据构成]), [
    ["001", 1300, "工资 + 报销"],
    ["002", 800, "仅工资"],
    ["003", 300, "仅报销"],
  ]);
  assert.deepEqual(result.statistics, {
    type: "personnel_cost",
    dateFrom: "2026-07-01",
    dateTo: "2026-07-31",
    personnelCount: 3,
    payrollAmount: 2000,
    expenseAmount: 400,
    totalCost: 2400,
    payrollDocuments: 3,
    expenseDocuments: 2,
    bothCount: 1,
    payrollOnlyCount: 1,
    expenseOnlyCount: 1,
    currencyCode: "PRE001",
  });
});

test("rejects adding personnel costs across currencies", () => {
  const range = personnelCostDateRange({ dateFrom: "2026-07-01", dateTo: "2026-07-31" });
  assert.throws(() => aggregatePersonnelCost(
    [{ 员工编号: "001", 姓名: "甲", 工资币别: "CNY", 实发工资: 100 }],
    [{ 员工编号: "001", 姓名: "甲", 报销币别: "USD", 报销类型: "B", 核定报销金额: 10 }],
    range,
  ), /多个币别/);
});

test("queries complete approved payroll and reimbursement sources for personnel cost", async () => {
  const requests = [];
  const kingdee = { executeBillQuery: async (username, request) => {
    assert.equal(username, "240001");
    requests.push(request);
    if (request.FormId === "PARA_PM_PayrollBill") return [["P1", "2026-07-01", "001", "甲", "研发", "PRE001", 1000]];
    if (request.FormId === "ER_ExpReimbursement") return [["E1", "2026-07-10", "001", "甲", "研发", "PRE001", "B", 200]];
    throw new Error(`unexpected form ${request.FormId}`);
  } };
  const engine = new QueryEngine({
    catalog,
    kingdee,
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 100, queryPageSize: 5000 } },
  });
  const result = await engine.execute(identity, { tool: "personnel_cost", arguments: { dateFrom: "2026-07-01", dateTo: "2026-07-31" } });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.TopRowCount === 0 && request.StartRow === 0 && request.Limit === 5000));
  assert.ok(requests.every((request) => /FDocumentStatus='C'/.test(request.FilterString)));
  assert.match(requests.find((request) => request.FormId === "ER_ExpReimbursement").FilterString, /F_PARA_ExType<>'A'/);
  assert.match(requests.find((request) => request.FormId === "ER_ExpReimbursement").FieldKeys, /F_PARA_ExType,FExpSubmitAmount$/);
  assert.equal(result.rows[0].人员成本, 1200);
  assert.equal(result.statistics.totalCost, result.statistics.payrollAmount + result.statistics.expenseAmount);
  assert.equal(result.truncated, false);
  assert.equal(result.partial, false);
});

test("queries an authorized expense header before returning its entry details", async () => {
  const requests = [];
  const kingdee = { executeBillQuery: async (username, request) => {
    assert.equal(username, "240001");
    requests.push(request);
    if (requests.length === 1) return [["BX'001", 300]];
    return [
      [101, "交通费", "B", "销售部", "P001", "一号项目", "SP001", "一期", "2026-08-01", "2026-08-01", "去程", 90, 10, 100, 100, 40],
      [102, "住宿费", "C", "销售部", "P001", "一号项目", "SP001", "一期", "2026-08-02", "2026-08-03", "住宿", 180, 20, 200, 200, 80],
    ];
  } };
  const engine = new QueryEngine({
    catalog,
    kingdee,
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 100 } },
  });
  const result = await engine.expenseDetails(identity, "BX'001");
  assert.equal(requests.length, 2);
  assert.match(requests[0].FilterString, /FBillNo='BX''001'/);
  assert.match(requests[0].FilterString, /FProposerID\.FName='张三'/);
  assert.equal(requests[0].FieldKeys, "FBillNo,FExpAmountSum");
  assert.doesNotMatch(requests[1].FieldKeys, /bank|account/i);
  assert.equal(result.count, 2);
  assert.equal(result.totals["申请报销金额"], 300);
  assert.equal(result.totals["费用金额"], 270);
  assert.deepEqual(result.reconciliation, { headerAmount: 300, detailAmount: 300, difference: 0, matches: true });
});

test("does not query expense entries when the scoped header is not visible", async () => {
  let calls = 0;
  const engine = new QueryEngine({
    catalog,
    kingdee: { executeBillQuery: async () => { calls += 1; return []; } },
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 100 } },
  });
  await assert.rejects(() => engine.expenseDetails(identity, "BX002"), /无权查看/);
  assert.equal(calls, 1);
});

test("maps current workflow nodes and handlers to read-only columns", () => {
  assert.deepEqual(workflowRows([[
    "FYBX20260803000026_20260810003015",
    "2026-08-10T00:30:15.893",
    "费用报销单",
    "2",
    "2026-08-10T00:30:17.177",
    "田凯",
    "二级部门主管审核",
  ]]), [{
    单据编号: "FYBX20260803000026",
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
  const kingdee = { executeBillQuery: async (username, request) => {
    assert.equal(username, "240001");
    requests.push(request);
    return [["BX001_20260810003015", "2026-08-10T00:30:15", "报销流程", "2", "2026-08-10T00:31:00", "李四", "部门审核"]];
  } };
  const engine = new QueryEngine({
    catalog,
    kingdee,
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 100 } },
  });
  const result = await engine.workflow(identity, { limit: 20 });
  assert.equal(requests[0].FormId, "WF_ProcInstBill");
  assert.match(requests[0].FilterString, /FOriginatorId\.FUserAccount='240001'/);
  assert.match(requests[0].FilterString, /FStatus='2'/);
  assert.equal(requests[0].Limit, 21);
  assert.equal(result.count, 1);
  assert.equal(result.rows[0].单据编号, "BX001");
  assert.equal(result.rows[0].当前节点, "部门审核");
  assert.equal(result.rows[0].当前处理人, "李四");
});

test("filters workflow rows by bill number without accepting arbitrary fields", async () => {
  let request;
  const engine = new QueryEngine({
    catalog,
    kingdee: { executeBillQuery: async (_username, value) => { request = value; return []; } },
    config: { scopeAdmins: new Set(), kingdee: { maxRows: 100 } },
  });
  await engine.workflow(identity, { billNumber: "BX'001", formId: "IGNORED", malicious: "1=1" });
  assert.match(request.FilterString, /FNumber LIKE 'BX''001%'/);
  assert.doesNotMatch(request.FilterString, /IGNORED|1=1/);
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
  assert.match(result.filter, /FNORECEIVEAMOUNT<>0/);
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

test("nets negative receivables with positive receivables", () => {
  const result = aggregateReceivableAging([
    { 应收单号: "AR-BLUE", 应收分录内码: 201, 应收日期: "2025-01-10T00:00:00", 客户: "客户甲", 销售子项目编码: "SP-NET", 销售子项目名称: "净额项目", 应收单总额: 100, 已收金额: 0, 未收金额: 100 },
    { 应收单号: "AR-RED", 应收分录内码: 202, 应收日期: "2025-02-10T00:00:00", 客户: "客户甲", 销售子项目编码: "SP-NET", 销售子项目名称: "净额项目", 应收单总额: -30, 已收金额: 0, 未收金额: -30 },
  ], {
    asOfDate: "2026-08-13",
    minimumDays: 180,
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]["应收金额"], 70);
  assert.equal(result.rows[0]["应收已收款金额"], 0);
  assert.equal(result.rows[0]["应收未收款金额"], 70);
  assert.equal(result.rows[0]["应收未开票金额"], 70);
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
  assert.match(requests[0].FilterString, /FNORECEIVEAMOUNT<>0/);
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
