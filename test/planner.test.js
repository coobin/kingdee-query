const test = require("node:test");
const assert = require("node:assert/strict");
const { localPlan } = require("../src/planner");

test("plans inventory query with material number", () => {
  const plan = localPlan("查询物料编码 A100 的库存");
  assert.equal(plan.tool, "inventory");
  assert.equal(plan.arguments.materialNumber, "A100");
});

test("plans current month expense query", () => {
  const plan = localPlan("查询本月我的报销单");
  assert.equal(plan.tool, "expense_claims");
  assert.match(plan.arguments.dateFrom, /^\d{4}-\d{2}-01$/);
});

test("plans expense workflow progress", () => {
  const plan = localPlan("报销单 BX202608120001 审批到哪里");
  assert.equal(plan.tool, "workflow_progress");
  assert.equal(plan.arguments.formId, "ER_ExpReimbursement");
  assert.equal(plan.arguments.billNumber, "BX202608120001");
});

test("plans a current user's workflow list", () => {
  const plan = localPlan("查询我发起的流程到哪个节点了");
  assert.equal(plan.tool, "workflow_progress");
  assert.equal(plan.arguments.scope, "mine");
  assert.equal(plan.arguments.billNumber, undefined);
});

test("plans historical expense amount aggregation", () => {
  const plan = localPlan("我历史报销的总金额是多少");
  assert.equal(plan.tool, "expense_claims");
  assert.equal(plan.arguments.aggregation, "sum_amount");
  assert.equal(plan.arguments.dateFrom, undefined);
});

test("plans current-year expense amount aggregation", () => {
  const plan = localPlan("我今年的报销总金额是多少");
  assert.equal(plan.arguments.aggregation, "sum_amount");
  assert.match(plan.arguments.dateFrom, /^\d{4}-01-01$/);
  assert.match(plan.arguments.dateTo, /^\d{4}-\d{2}-\d{2}$/);
});

test("plans an overdue invoiced receivable query", () => {
  const plan = localPlan("统计超过 180 天还没回款的开票应收");
  assert.equal(plan.tool, "overdue_receivables");
  assert.equal(plan.arguments.minimumDays, 180);
  assert.equal(plan.arguments.dateFrom, undefined);
});

test("plans the invoice aging query by its user-facing name", () => {
  const plan = localPlan("查询发票账龄超过180天的项目");
  assert.equal(plan.tool, "overdue_receivables");
  assert.equal(plan.arguments.minimumDays, 180);
});

test("plans an overdue receivable query for a sales subproject", () => {
  const plan = localPlan("查询销售子项目 QC-JE2019060-61 超过365天未回款");
  assert.equal(plan.tool, "overdue_receivables");
  assert.equal(plan.arguments.minimumDays, 365);
  assert.equal(plan.arguments.subprojectNumber, "QC-JE2019060-61");
});

test("plans the independent AR and receipt aging query", () => {
  const plan = localPlan("按应收单和收款维度统计销售子项目 SP-AR 超过180天未收款");
  assert.equal(plan.tool, "receivable_aging");
  assert.equal(plan.arguments.minimumDays, 180);
  assert.equal(plan.arguments.subprojectNumber, "SP-AR");
});

test("plans the combined overdue risk query with independent thresholds", () => {
  const plan = localPlan("比较开票超过180天和应收超过270天的未回款风险");
  assert.equal(plan.tool, "overdue_risk_combined");
  assert.equal(plan.arguments.invoiceDays, 180);
  assert.equal(plan.arguments.receivableDays, 270);
});

test("plans an inventory cycle query for customer pending signoff", () => {
  const plan = localPlan("查询销售子项目 SP1 客户仓待签收超过30天的库存周期");
  assert.equal(plan.tool, "inventory_cycle");
  assert.equal(plan.arguments.subprojectNumber, "SP1");
  assert.equal(plan.arguments.warehouseScope, "customer");
  assert.equal(plan.arguments.minimumDays, 30);
});

test("plans an inventory cycle query for company warehouse", () => {
  const plan = localPlan("查询公司仓库存周期超过60天的物料");
  assert.equal(plan.tool, "inventory_cycle");
  assert.equal(plan.arguments.warehouseScope, "company");
  assert.equal(plan.arguments.minimumDays, 60);
});

test("plans an inventory cycle query using only the age threshold", () => {
  const plan = localPlan("查询库存周期超过180天的物料");
  assert.equal(plan.tool, "inventory_cycle");
  assert.equal(plan.arguments.minimumDays, 180);
  assert.equal(plan.arguments.materialNumber, undefined);
});
