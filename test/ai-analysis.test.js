const test = require("node:test");
const assert = require("node:assert/strict");
const { AIClient } = require("../src/ai/client");
const { AnalysisContextStore } = require("../src/ai/context-store");
const { AIAnalysisService, normalizeAnalysis } = require("../src/ai/analysis-service");
const { buildSummaryContext } = require("../src/ai/analysis-profiles");

const identity = { userId: "240001", kingdeeUsername: "240001", name: "张三" };

function combinedResult() {
  return {
    tool: "overdue_risk_combined",
    label: "超期风险",
    query: { asOfDate: "2026-08-31", invoiceDays: 180, receivableDays: 270 },
    columns: ["客户", "销售子项目编码", "最终超期风险金额"],
    rows: [{
      客户: "客户甲",
      销售子项目编码: "SP-001",
      销售子项目名称: "一期",
      开票未回款金额: 1200,
      应收未收款金额: 900,
      金额差异: 300,
      最终超期风险金额: 1200,
      采用口径: "发票超期",
      账龄日期: "2026-01-01",
      超期天数: 242,
      超期阈值: 180,
      超期发票数: 1,
      超期应收单数: 1,
      应收未开票金额: 0,
      未生成应收金额: 0,
      回款状态: "部分回款未结清",
      收款条件: "月结30天",
    }],
    count: 1,
    truncated: false,
    partial: false,
    statistics: { finalRiskAmount: 1200, customerCount: 1, partial: false },
    summary: "截至 2026-08-31，共 1 个销售子项目。",
  };
}

function detailResult() {
  const result = combinedResult();
  return {
    tool: "overdue_risk_detail",
    label: "超期风险明细",
    query: { asOfDate: "2026-08-31", invoiceDays: 180, receivableDays: 270, subprojectNumber: "SP-001" },
    combinedRow: result.rows[0],
    invoiceResult: {
      rows: [{
        销售子项目编码: "SP-001", 开票日期: "2026-01-01", 开票金额: 1200,
        已收款金额: 0, 收款未核销金额: 0, 未生成应收金额: 0, 未回款金额: 1200,
        超期天数: 242, 超期发票数: 1, 回款状态: "完全未回款",
      }],
      truncated: false,
      analysisSources: {
        invoices: { rows: [{ 销售发票号: "INV-001", 开票日期: "2026-01-01", 发票金额: 1200, 红蓝字标识: "0", 销售子项目编码: "SP-001" }], count: 1, truncated: false },
        overdueInvoices: { rows: [{ 销售发票号: "INV-001", 开票日期: "2026-01-01", 发票金额: 1200, 红蓝字标识: "0", 销售子项目编码: "SP-001" }], count: 1, truncated: false },
        invoiceWriteoffs: { rows: [{ 来源单据号: "INV-001", 目标单据号: "AR-001", 本次开票核销金额: 1200, 累计开票核销金额: 1200 }], count: 1, truncated: false },
        receiptWriteoffs: { rows: [], count: 0, truncated: false },
        receipts: { rows: [], count: 0, truncated: false },
        refunds: { rows: [], count: 0, truncated: false },
        paymentConditions: { rows: [{ 收款条件: "月结30天" }], count: 1, truncated: false },
      },
    },
    receivableResult: {
      rows: [{
        销售子项目编码: "SP-001", 应收账龄日期: "2026-01-01", 应收金额: 900,
        应收已收款金额: 0, 应收未收款金额: 900, 应收未开票金额: 0,
        应收超期天数: 242, 应收单数: 1, 回款状态: "完全未回款",
      }],
      truncated: false,
      analysisSources: {
        receivables: { rows: [{ 应收单号: "AR-001", 应收日期: "2026-01-01", 客户: "客户甲", 应收单总额: 900, 已开票金额: 900, 已收金额: 0, 未收金额: 900 }], count: 1, truncated: false },
        invoiceWriteoffs: { rows: [], count: 0, truncated: false },
        paymentConditions: { rows: [], count: 0, truncated: false },
      },
    },
  };
}

function fakeCompletion(refs = ["P001"]) {
  return JSON.stringify({
    headline: "需要优先核对",
    riskLevel: "high",
    overview: "存在需要优先复核的超期余额。",
    keyFindings: [{ title: "风险集中", description: "风险金额需要结合核销记录进一步核对。", severity: "high", refs }],
    priorityActions: [{ action: "核对发票与应收匹配", reason: "确认余额归属。", refs }],
    caveats: ["AI 结论不能替代金蝶原单。"],
  });
}

test("DeepSeek client sends JSON mode and parses a completion", async () => {
  const calls = [];
  const client = new AIClient({ baseUrl: "https://api.deepseek.com", apiKey: "secret-for-test", model: "deepseek-v4-flash", timeoutMs: 5000, maxTokens: 600 }, async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      json: async () => ({ model: "deepseek-v4-flash", choices: [{ message: { content: '{"headline":"ok"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }),
    };
  });
  const result = await client.complete({ systemPrompt: "return JSON", userContent: "{}" });
  assert.equal(result.content, '{"headline":"ok"}');
  assert.equal(result.usage.total_tokens, 14);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "deepseek-v4-flash");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.max_tokens, 600);
  assert.equal(body.stream, false);
  assert.match(calls[0].options.headers.Authorization, /^Bearer /);
});

test("DeepSeek client consumes SSE JSON deltas", async () => {
  const encoder = new TextEncoder();
  const events = [
    `data: ${JSON.stringify({ model: "deepseek-v4-flash", choices: [{ delta: { content: '{"headline":"' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok\"}" }, finish_reason: "stop" }], usage: { total_tokens: 6 } })}\n\n`,
    "data: [DONE]\n\n",
  ].map((value) => encoder.encode(value));
  let index = 0;
  const client = new AIClient({ baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-v4-flash" }, async () => ({
    ok: true,
    body: { getReader: () => ({ read: async () => (index < events.length ? { value: events[index++], done: false } : { value: undefined, done: true }) }) },
  }));
  const deltas = [];
  const result = await client.complete({ systemPrompt: "return JSON", userContent: "{}", stream: true, onDelta: (delta) => deltas.push(delta) });
  assert.equal(result.content, '{"headline":"ok"}');
  assert.deepEqual(deltas, ['{"headline":"', 'ok"}']);
  assert.equal(result.usage.total_tokens, 6);
});

test("analysis context is short-lived and user-bound", () => {
  let now = 1000;
  const store = new AnalysisContextStore({ ttlMs: 60000, now: () => now });
  const created = store.create({ identity, tool: "overdue_risk_combined", plan: { tool: "overdue_risk_combined", arguments: {} }, result: combinedResult() });
  assert.equal(store.get(created.id, identity).result.rows.length, 1);
  assert.throws(() => store.get(created.id, { kingdeeUsername: "240002" }), (error) => error.statusCode === 403);
  now += 60001;
  assert.throws(() => store.get(created.id, identity), (error) => error.statusCode === 410);
});

test("summary context redacts identifiers while retaining evidence mapping", () => {
  const context = buildSummaryContext(combinedResult(), { redactIdentifiers: true, maxRows: 40 });
  const modelText = JSON.stringify({ ...context, references: undefined, allowedRefs: undefined });
  assert.equal(modelText.includes("客户甲"), false);
  assert.equal(modelText.includes("SP-001"), false);
  assert.equal(context.references[0].subprojectNumber, "SP-001");
  assert.deepEqual(context.allowedRefs, ["P001"]);
});

test("analysis service caches summaries and keeps only valid references", async () => {
  const store = new AnalysisContextStore({ ttlMs: 60000 });
  const prompts = [];
  let calls = 0;
  const client = {
    model: "deepseek-v4-flash",
    available: () => true,
    complete: async ({ userContent, stream }) => {
      calls += 1;
      prompts.push(JSON.parse(userContent));
      assert.equal(stream, false);
      return { content: fakeCompletion(["P001", "NOT-ALLOWED"]), finishReason: "stop", model: "deepseek-v4-flash", usage: { total_tokens: 20 } };
    },
  };
  const service = new AIAnalysisService({
    client,
    config: { enabled: true, topRows: 40, detailRows: 300, redactIdentifiers: true, cacheTtlMs: 60000, rateLimit: 5, rateLimitWindowMs: 60000 },
    contextStore: store,
  });
  const context = service.createContext(identity, { tool: "overdue_risk_combined", arguments: {} }, combinedResult());
  const first = await service.analyze(identity, { contextId: context.contextId });
  const second = await service.analyze(identity, { contextId: context.contextId });
  assert.equal(calls, 1);
  assert.deepEqual(first.analysis.keyFindings[0].refs, ["P001"]);
  assert.equal(first.analysis.evidenceReferences.length, 1);
  assert.equal(first.meta.cached, false);
  assert.equal(second.meta.cached, true);
  assert.equal(JSON.stringify(prompts[0]).includes("客户甲"), false);
  assert.equal(JSON.stringify(prompts[0]).includes("SP-001"), false);
});

test("selected project analysis refreshes source detail and maps document evidence", async () => {
  const store = new AnalysisContextStore({ ttlMs: 60000 });
  let prompt;
  const client = {
    model: "deepseek-v4-flash",
    available: () => true,
    complete: async ({ userContent }) => {
      prompt = JSON.parse(userContent);
      return { content: fakeCompletion(["P001", "I001", "A001", "NOT-ALLOWED"]), finishReason: "stop", model: "deepseek-v4-flash", usage: null };
    },
  };
  let loadedCode = "";
  const service = new AIAnalysisService({
    client,
    engine: { overdueRiskDetails: async (currentIdentity, args) => { assert.equal(currentIdentity, identity); loadedCode = args.subprojectNumber; return detailResult(); } },
    config: { enabled: true, topRows: 40, detailRows: 300, redactIdentifiers: true, cacheTtlMs: 60000, rateLimit: 5, rateLimitWindowMs: 60000 },
    contextStore: store,
  });
  const context = service.createContext(identity, { tool: "overdue_risk_combined", arguments: {} }, combinedResult());
  const output = await service.analyze(identity, { contextId: context.contextId, subprojectNumbers: ["SP-001"] });
  assert.equal(output.meta.mode, "project");
  assert.equal(loadedCode, "SP-001");
  assert.deepEqual(output.analysis.evidenceReferences.map((item) => item.documentNumber).filter(Boolean).sort(), ["AR-001", "INV-001"]);
  assert.equal(JSON.stringify(prompt).includes("客户甲"), false);
  assert.equal(JSON.stringify(prompt).includes("INV-001"), false);
  assert.equal(JSON.stringify(prompt).includes("AR-001"), false);
});

test("normalizing model output strips invalid references and fences", () => {
  const normalized = normalizeAnalysis(JSON.parse('{"headline":"x","riskLevel":"高","overview":"y","keyFindings":[{"description":"z","refs":["P001","bad"]}]}'), new Set(["P001"]));
  assert.equal(normalized.riskLevel, "high");
  assert.deepEqual(normalized.keyFindings[0].refs, ["P001"]);
});
