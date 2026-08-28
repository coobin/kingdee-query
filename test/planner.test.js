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

test("plans personnel cost before the generic reimbursement tool", () => {
  const plan = localPlan("计算工资和报销构成的人员成本");
  assert.equal(plan.tool, "personnel_cost");
  assert.match(plan.arguments.dateFrom, /^\d{4}-\d{2}-01$/);
  assert.match(plan.arguments.dateTo, /^\d{4}-\d{2}-\d{2}$/);
});

test("plans expense workflow progress", () => {
  const plan = localPlan("报销单 BX202608120001 审批到哪里");
  assert.equal(plan.tool, "workflow_progress");
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

test("plans supplier procurement analysis before the generic purchase order tool", () => {
  const plan = localPlan("查询今年每家供应商的采购金额、入库和付款情况");
  assert.equal(plan.tool, "supplier_purchase_analysis");
  assert.match(plan.arguments.dateFrom, /^\d{4}-01-01$/);
  assert.match(plan.arguments.dateTo, /^\d{4}-\d{2}-\d{2}$/);
});

test("extracts supplier number and previous-year range", () => {
  const plan = localPlan("查询供应商编码 VEN00155 去年的采购订单和退料");
  assert.equal(plan.tool, "supplier_purchase_analysis");
  assert.equal(plan.arguments.supplierNumber, "VEN00155");
  assert.equal(plan.arguments.dateFrom, `${new Date().getFullYear() - 1}-01-01`);
  assert.equal(plan.arguments.dateTo, `${new Date().getFullYear() - 1}-12-31`);
});

test("extracts a quoted supplier name for procurement analysis", () => {
  const plan = localPlan("查询供应商“示例供应商”的采购金额");
  assert.equal(plan.tool, "supplier_purchase_analysis");
  assert.equal(plan.arguments.supplierName, "示例供应商");
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

test("plans sales business analysis before the generic sales order tool", () => {
  const plan = localPlan("统计今年销售子项目的预计毛利率、订单交付和回款");
  assert.equal(plan.tool, "sales_business_analysis");
  assert.equal(plan.arguments.dateFrom, `${new Date().getFullYear()}-01-01`);
  assert.ok(plan.arguments.dateTo);
});

test("plans sales business filters without confusing a project code with a subproject code", () => {
  const plan = localPlan("查询销售项目编码：P-001 的销售经营分析，销售员：张三，销售组织：华东");
  assert.equal(plan.tool, "sales_business_analysis");
  assert.equal(plan.arguments.projectNumber, "P-001");
  assert.equal(plan.arguments.subprojectNumber, undefined);
  assert.equal(plan.arguments.salespersonName, "张三");
  assert.equal(plan.arguments.organizationName, "华东");
});

test("plans project purchase-sales consistency queries with base-data codes", () => {
  const plan = localPlan("查询购销一致性报表，销售项目编码：P-001，销售子项目编码：SP-001，业务组织编码：100");
  assert.equal(plan.tool, "project_pur_sale_consistency");
  assert.equal(plan.arguments.projectNumber, "P-001");
  assert.equal(plan.arguments.subprojectNumber, "SP-001");
  assert.equal(plan.arguments.organizationNumber, "100");
});
