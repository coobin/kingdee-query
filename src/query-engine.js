const { KingdeeError } = require("./kingdee");

function escapeValue(value) {
  return String(value).replaceAll("'", "''").replace(/[\u0000-\u001f]/g, "");
}

function isoDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`日期格式应为 YYYY-MM-DD：${text}`);
  return text;
}

function buildFilter(item, args, identity, config) {
  const clauses = [];
  const accepted = {};
  for (const [key, raw] of Object.entries(args || {})) {
    if (raw == null || raw === "" || key === "limit") continue;
    const field = item.filterFields[key];
    if (!field) continue;
    const value = escapeValue(raw);
    if (key === "dateFrom") clauses.push(`${field}>='${isoDate(value)}'`);
    else if (key === "dateTo") clauses.push(`${field}<'${nextDay(isoDate(value))}'`);
    else if (key.endsWith("Name")) clauses.push(`${field} LIKE '%${value}%'`);
    else clauses.push(`${field}='${value}'`);
    accepted[key] = raw;
  }

  if (item.forceSelfScope && !config.scopeAdmins.has(identity.kingdeeUsername)) {
    const source = item.selfValueSource || "kingdeeUsername";
    const ownValue = escapeValue(identity[source] || identity.kingdeeUsername);
    clauses.push(`${item.selfField}='${ownValue}'`);
    accepted.scope = "self";
  }
  if (!clauses.length && item.requiresFilter) {
    throw Object.assign(new Error("查询范围过大，请至少提供一个筛选条件。"), { statusCode: 400 });
  }
  return { filter: clauses.join(" AND "), accepted };
}

function nextDay(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function normalizeLimit(value, maxRows) {
  const parsed = Number(value || 50);
  if (!Number.isInteger(parsed) || parsed < 1) return 50;
  return Math.min(parsed, maxRows);
}

function rowsToObjects(rows, fields, valueMappings = {}) {
  const labels = fields.map(([, label]) => label);
  return rows.map((row) => Object.fromEntries(labels.map((label, index) => {
    const value = row[index];
    const mapping = valueMappings[label];
    if (!mapping || value == null || value === "") return [label, value];
    return [label, mapping[String(value)] || "其他状态"];
  })));
}

class QueryEngine {
  constructor({ catalog, kingdee, config }) {
    this.catalog = catalog;
    this.kingdee = kingdee;
    this.config = config;
  }

  async execute(identity, plan) {
    if (plan.tool === "workflow_progress") return this.workflow(identity, plan.arguments || {});
    const item = this.catalog[plan.tool];
    if (!item) throw Object.assign(new Error(`不支持的查询工具：${plan.tool}`), { statusCode: 400 });
    const args = plan.arguments || {};
    const { filter, accepted } = buildFilter(item, args, identity, this.config);
    const limit = normalizeLimit(args.limit, this.config.kingdee.maxRows);
    const request = {
      FormId: item.formId,
      FieldKeys: item.fields.map(([key]) => key).join(","),
      FilterString: filter,
      OrderString: item.defaultOrder || "",
      StartRow: 0,
      Limit: limit,
      TopRowCount: 0,
    };
    const aggregation = resolveAggregation(item, args.aggregation);
    const rows = aggregation
      ? await this.queryForAggregation(identity, request)
      : await this.kingdee.executeBillQuery(identity.kingdeeUsername, request);
    const objects = rowsToObjects(rows, item.fields, item.valueMappings);
    const aggregate = aggregation ? calculateAggregate(objects, aggregation, rows.length >= this.config.kingdee.aggregationMaxRows) : null;
    const visibleObjects = aggregation ? objects.slice(0, limit) : objects;
    return {
      tool: plan.tool,
      label: item.label,
      query: accepted,
      columns: item.fields.map(([, label]) => label),
      rows: visibleObjects,
      count: rows.length,
      truncated: aggregation ? aggregate.partial : rows.length >= limit,
      aggregate,
      summary: aggregate ? summarizeAggregate(item.label, aggregate) : summarize(item.label, objects, rows.length >= limit),
    };
  }

  async queryForAggregation(identity, request) {
    const pageSize = Math.min(this.config.kingdee.maxRows, 200);
    const maximum = this.config.kingdee.aggregationMaxRows;
    const rows = [];
    while (rows.length < maximum) {
      const page = await this.kingdee.executeBillQuery(identity.kingdeeUsername, {
        ...request,
        StartRow: rows.length,
        Limit: Math.min(pageSize, maximum - rows.length),
      });
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  }

  async workflow(identity, args) {
    const billNumber = String(args.billNumber || "").trim();
    const formId = String(args.formId || "").trim();
    if (!billNumber || !formId) {
      throw Object.assign(new Error("查询审批进度需要 formId 和 billNumber。"), { statusCode: 400 });
    }
    const payload = await this.kingdee.workflowProgress(
      identity.kingdeeUsername,
      this.config.kingdee.workflowMethod,
      { FormId: formId, Number: billNumber },
    );
    return {
      tool: "workflow_progress",
      label: "审批进度",
      query: { formId, billNumber },
      workflow: payload,
      count: 1,
      summary: `已取得单据 ${billNumber} 的审批进度。`,
    };
  }
}

function summarize(label, rows, truncated) {
  if (!rows.length) return `没有找到符合条件的${label}。`;
  return `找到 ${rows.length} 条${label}${truncated ? "，结果已达到本次返回上限" : ""}。`;
}

function resolveAggregation(item, requested) {
  if (requested !== "sum_amount") return null;
  const field = item.fields.find(([, label]) => /(?:费用金额|价税合计|金额)/.test(label));
  if (!field) throw Object.assign(new Error(`当前${item.label}查询不支持金额汇总。`), { statusCode: 400 });
  return { operation: "sum", field: field[1], label: "总金额", unit: "元" };
}

function calculateAggregate(rows, aggregation, partial) {
  const value = rows.reduce((total, row) => {
    const current = Number(row[aggregation.field]);
    return total + (Number.isFinite(current) ? current : 0);
  }, 0);
  return { ...aggregation, value: Math.round((value + Number.EPSILON) * 100) / 100, records: rows.length, partial };
}

function summarizeAggregate(label, aggregate) {
  if (!aggregate.records) return `没有找到符合条件的${label}，总金额为 0 元。`;
  const amount = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(aggregate.value);
  return `共 ${aggregate.records} 笔${label}，总金额为 ¥${amount}${aggregate.partial ? "（已达到汇总上限，结果可能不完整）" : ""}。`;
}

module.exports = { QueryEngine, buildFilter, rowsToObjects, escapeValue, resolveAggregation, calculateAggregate };
