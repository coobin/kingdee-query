const Ajv = require("ajv");
const { createHash } = require("node:crypto");

const object = (properties, extra = {}) => ({
  type: "object", properties, additionalProperties: false, ...extra,
});
const str = (description, maxLength = 120) => ({
  type: "string", description, minLength: 1, maxLength, pattern: "^\\S(?:.*\\S)?$",
});
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "日期 YYYY-MM-DD" };
const limit = { type: "integer", minimum: 1, maximum: 200, description: "最多返回的明细条数（以模块上限为准）" };
const days = { type: "integer", minimum: 1, maximum: 3650, description: "账龄阈值（天）" };
const named = {
  dateFrom: date, dateTo: date, minimumDays: days, invoiceDays: days, receivableDays: days,
  warehouseScope: { type: "string", enum: ["all", "company", "project", "customer"] },
};

const grains = {
  inventory: "库存明细行", inventory_cycle: "当前库存明细行", sales_orders: "销售订单头",
  purchase_orders: "采购订单头", sales_business_analysis: "销售子项目",
  project_pur_sale_consistency: "项目及关联单据展开行", overdue_receivables: "销售子项目（发票口径）",
  receivable_aging: "销售子项目（应收口径）", overdue_risk_combined: "销售子项目（双口径）",
  supplier_purchase_analysis: "供应商汇总", personnel_cost: "人员期间汇总",
  expense_claims: "费用报销单据头", workflow_progress: "本人发起的审批中流程",
};

function buildRegistry(catalog, handlers) {
  const ajv = new Ajv({ strictRequired: false });
  const entries = new Map();
  function add(id, item, operation, inputSchema, grain, run) {
    const name = id + "_" + operation;
    if (!/^[a-z][a-z0-9_]{0,45}$/.test(id) || !/^[a-z][a-z0-9_]{0,53}$/.test(name) || entries.has(name) || typeof run !== "function") {
      throw new Error("Invalid MCP operation: " + name);
    }
    const scope = "queryhub:" + id + ":read";
    const meta = { moduleId: id, title: item.label, scope, version: item.mcp?.version ?? 1,
      sensitivity: item.restrictedByDefault ? "restricted" : "internal", grain };
    const definition = { name, description: operation === "query" ? item.description : "查看" + item.label + "详情",
      inputSchema,
      outputSchema: {
        type: "object",
        required: ["grain", "completeness", "queriedAt", "contractVersion"],
        properties: {
          grain: { type: "string" },
          completeness: { type: "string", enum: ["complete", "partial", "unknown"] },
          queriedAt: { type: "string" },
          contractVersion: { type: "integer" },
          returnedCount: { type: "integer", minimum: 0 },
          rows: { type: "array", items: { type: "object" } },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };
    if (!meta.title || !definition.description || !grain || !Number.isSafeInteger(meta.version) || meta.version < 1) {
      throw new Error("Incomplete MCP contract: " + name);
    }
    const hash = createHash("sha256").update(JSON.stringify([definition, meta, item])).digest("hex");
    const tool = { ...definition, _meta: { "chency/capability": { ...meta, hash } } };
    entries.set(name, { id, scope, hash, grain, tool, validate: ajv.compile(inputSchema), run });
  }

  for (const [id, item] of Object.entries(catalog)) {
    if (item.mcp?.enabled === false) continue;
    const fields = Object.fromEntries(Object.keys(item.filterFields).map((key) => [key, named[key] || str(key)]));
    if (item.projectOwnershipOptions) {
      fields.projectOwnerships = { type: "array", maxItems: 6, uniqueItems: true, items: str("项目归属编码") };
    }
    if (id === "expense_claims") fields.aggregation = { type: "string", enum: ["sum_amount"] };
    const filters = Object.keys(fields).filter((key) => key !== "aggregation");
    add(id, item, "query", item.mcp?.inputSchema ?? object({ ...fields, limit }, item.requiresFilter
      ? { anyOf: filters.map((key) => ({ required: [key] })) } : {}),
    item.mcp?.grain ?? grains[id], (req, args) => handlers.query(req, id, args));
    if (id === "expense_claims") add(id, item, "detail",
      object({ billNumber: str("报销单号", 80) }, { required: ["billNumber"] }), "费用报销单据详情", handlers.expense);
    if (id === "sales_business_analysis") add(id, item, "detail",
      object({ subprojectNumber: str("销售子项目编码", 80), dateFrom: date, dateTo: date,
        customerName: str("客户名称", 80), projectNumber: str("项目编码", 60) },
      { required: ["subprojectNumber"] }), "销售子项目及关联合同与往来明细", handlers.sales);
  }
  add("workflow_progress", { label: "审批进度", description: "查询本人发起且正在审批的流程" },
    "query", object({ billNumber: str("单据号或前缀"), limit }), grains.workflow_progress,
    (req, args) => handlers.query(req, "workflow_progress", args));
  return entries;
}

function validDates(args) {
  for (const key of ["dateFrom", "dateTo"]) {
    if (!args[key]) continue;
    const d = new Date(args[key] + "T00:00:00Z");
    if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== args[key]) return false;
  }
  return !(args.dateFrom && args.dateTo && args.dateFrom > args.dateTo);
}

module.exports = { buildRegistry, validDates };
