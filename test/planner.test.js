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
