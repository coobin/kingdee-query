const { AIProviderError } = require("./client");
const { identityKey } = require("./context-store");
const { cleanText, getAnalysisProfile, projectKey } = require("./analysis-profiles");

function requestError(message, statusCode = 400, code = "invalid_request") {
  return Object.assign(new Error(message), { statusCode, code });
}

function normalizeText(value, maximum = 600) {
  return cleanText(value, maximum);
}

function normalizeRiskLevel(value) {
  const text = String(value || "").trim().toLowerCase();
  return ({
    high: "high",
    medium: "medium",
    low: "low",
    unknown: "unknown",
    高: "high",
    中: "medium",
    低: "low",
    未知: "unknown",
    无法判断: "unknown",
  })[text] || "unknown";
}

function normalizeSeverity(value) {
  const level = normalizeRiskLevel(value);
  return ["high", "medium", "low"].includes(level) ? level : "medium";
}

function normalizeRefs(value, allowedRefs = new Set()) {
  const values = Array.isArray(value) ? value : (value == null || value === "" ? [] : [value]);
  return [...new Set(values.map((item) => String(item || "").trim()).filter((item) => allowedRefs.has(item)))].slice(0, 12);
}

function normalizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map((item) => ({
    field: normalizeText(item?.field, 100),
    meaning: normalizeText(item?.meaning || item?.description, 260),
  })).filter((item) => item.field || item.meaning);
}

function normalizeAnalysis(raw, allowedRefs) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AIProviderError("AI 返回的分析结构不正确。", { code: "invalid_json_shape" });
  }
  const findings = Array.isArray(raw.keyFindings) ? raw.keyFindings : (Array.isArray(raw.findings) ? raw.findings : []);
  const actions = Array.isArray(raw.priorityActions) ? raw.priorityActions : (Array.isArray(raw.actions) ? raw.actions : []);
  const caveats = Array.isArray(raw.caveats) ? raw.caveats : [];
  return {
    headline: normalizeText(raw.headline || raw.title, 180) || "需要人工复核的超期风险",
    riskLevel: normalizeRiskLevel(raw.riskLevel || raw.risk || raw.level),
    overview: normalizeText(raw.overview || raw.summary, 1200) || "AI 未能生成有效概览，请结合下方结构化数据复核。",
    keyFindings: findings.slice(0, 8).map((item) => ({
      title: normalizeText(item?.title || item?.name, 140) || "重点发现",
      description: normalizeText(item?.description || item?.detail, 600),
      severity: normalizeSeverity(item?.severity || item?.riskLevel),
      refs: normalizeRefs(item?.refs || item?.references, allowedRefs),
      evidence: normalizeEvidence(item?.evidence),
    })).filter((item) => item.description || item.evidence.length),
    priorityActions: actions.slice(0, 8).map((item) => ({
      action: normalizeText(item?.action || item?.title, 360),
      reason: normalizeText(item?.reason || item?.description, 500),
      refs: normalizeRefs(item?.refs || item?.references, allowedRefs),
    })).filter((item) => item.action || item.reason),
    caveats: caveats.slice(0, 8).map((item) => normalizeText(typeof item === "string" ? item : item?.description, 500)).filter(Boolean),
    evidenceReferences: [],
  };
}

function collectAnalysisRefs(analysis) {
  const refs = new Set();
  for (const finding of analysis?.keyFindings || []) {
    for (const ref of finding.refs || []) refs.add(ref);
  }
  for (const action of analysis?.priorityActions || []) {
    for (const ref of action.refs || []) refs.add(ref);
  }
  return refs;
}

function parseJsonContent(content) {
  let text = String(content || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AIProviderError("AI 返回的内容不是合法 JSON。", { code: "invalid_json" });
  }
}

function modelContext(prepared) {
  const { references, allowedRefs, ...safeContext } = prepared || {};
  return safeContext;
}

function normalizeSelection(values) {
  const list = Array.isArray(values) ? values : (values == null || values === "" ? [] : [values]);
  if (list.length > 5) throw requestError("一次最多选择 5 个销售子项目进行 AI 明细分析。", 400, "selection_too_large");
  const normalized = list.map((value) => String(value || "").trim().slice(0, 100));
  if (normalized.some((value) => !value)) throw requestError("选择的销售子项目编码不正确。", 400, "invalid_selection");
  return [...new Set(normalized)];
}

function buildAnswer(analysis) {
  const sections = [analysis.headline, analysis.overview];
  if (analysis.keyFindings.length) {
    sections.push(`重点发现：${analysis.keyFindings.slice(0, 3).map((item) => item.description || item.title).filter(Boolean).join("；")}`);
  }
  if (analysis.priorityActions.length) {
    sections.push(`优先跟进：${analysis.priorityActions.slice(0, 3).map((item) => item.action || item.reason).filter(Boolean).join("；")}`);
  }
  if (analysis.caveats.length) sections.push(`注意：${analysis.caveats.slice(0, 2).join("；")}`);
  return sections.filter(Boolean).join("\n").slice(0, 3600);
}

class AIAnalysisService {
  constructor({ client, engine, config, contextStore } = {}) {
    this.client = client;
    this.engine = engine;
    this.config = config || {};
    this.contextStore = contextStore;
    this.rateEntries = new Map();
  }

  capabilities() {
    const available = Boolean(this.config.enabled && this.client?.available?.());
    return {
      enabled: available,
      streaming: available,
      supportsSelection: available,
      modules: available ? ["overdue_risk_combined"] : [],
    };
  }

  ensureReady() {
    if (!this.config.enabled) throw requestError("AI 分析功能尚未启用。", 503, "disabled");
    if (!this.client?.available?.()) throw requestError("AI 分析缺少服务地址、API Key 或模型配置。", 503, "not_configured");
    if (!this.contextStore) throw requestError("AI 分析上下文存储未初始化。", 503, "context_store_unavailable");
  }

  createContext(identity, plan, result) {
    if (!this.config.enabled || !this.client?.available?.()) return null;
    const profile = getAnalysisProfile(plan?.tool || result?.tool);
    if (!profile || !result || !Array.isArray(result.rows)) return null;
    const entry = this.contextStore.create({ identity, tool: profile.id, plan, result });
    return {
      contextId: entry.id,
      expiresAt: entry.expiresAt,
      profile: profile.id,
      supportsSelection: Boolean(profile.supportsSelection),
    };
  }

  takeRate(identity) {
    const key = identityKey(identity) || "anonymous";
    const now = Date.now();
    const windowMs = Math.min(Math.max(Number(this.config.rateLimitWindowMs) || 600000, 60000), 3600000);
    const limit = Math.min(Math.max(Number(this.config.rateLimit) || 5, 1), 100);
    const entries = (this.rateEntries.get(key) || []).filter((timestamp) => timestamp > now - windowMs);
    if (entries.length >= limit) {
      this.rateEntries.set(key, entries);
      throw requestError("AI 分析请求过于频繁，请稍后再试。", 429, "rate_limited");
    }
    entries.push(now);
    this.rateEntries.set(key, entries);
  }

  async analyze(identity, { contextId, subprojectNumbers = [] } = {}, { onDelta = null } = {}) {
    this.ensureReady();
    const context = this.contextStore.get(contextId, identity);
    const profile = getAnalysisProfile(context.tool);
    if (!profile) throw requestError("当前查询模块暂不支持 AI 分析。", 400, "profile_unavailable");
    if (!context.result.rows?.length) throw requestError("当前查询没有可供 AI 分析的数据。", 400, "empty_result");

    const requested = normalizeSelection(subprojectNumbers);
    const rowByCode = new Map((context.result.rows || []).map((row) => [projectKey(row?.["销售子项目编码"]), row]));
    const selectedCodes = requested.map((requestedCode) => {
      const row = rowByCode.get(projectKey(requestedCode));
      if (!row) throw requestError(`没有在本次查询结果中找到销售子项目：${requestedCode}。`, 404, "selection_not_in_context");
      return String(row["销售子项目编码"] || requestedCode).trim();
    });
    const mode = selectedCodes.length ? "project" : "summary";
    const cacheKey = [mode, ...selectedCodes.map(projectKey).sort(), this.client.model, this.config.redactIdentifiers !== false].join(":");
    const cached = this.contextStore.getCached(context, cacheKey);
    if (cached) return { ...cached, meta: { ...cached.meta, cached: true } };
    this.takeRate(identity);

    let prepared;
    if (mode === "summary") {
      prepared = profile.buildSummaryContext(context.result, {
        maxRows: this.config.topRows,
        redactIdentifiers: this.config.redactIdentifiers !== false,
      });
    } else {
      if (!profile.supportsSelection || typeof profile.loadProjectDetails !== "function") {
        throw requestError("当前查询模块暂不支持单项目 AI 明细分析。", 400, "selection_unavailable");
      }
      const details = [];
      for (const code of selectedCodes) {
        details.push(await profile.loadProjectDetails({
          engine: this.engine,
          identity,
          context,
          code,
          maxDetailRows: this.config.detailRows,
        }));
      }
      prepared = profile.buildProjectContext({
        context,
        details,
        options: {
          maxRows: this.config.detailRows,
          redactIdentifiers: this.config.redactIdentifiers !== false,
        },
      });
    }

    const completion = await this.client.complete({
      systemPrompt: profile.systemPrompt(mode),
      userContent: JSON.stringify(modelContext(prepared)),
      maxTokens: this.config.maxTokens,
      stream: typeof onDelta === "function",
      onDelta,
    });
    if (["length", "max_tokens"].includes(String(completion.finishReason || ""))) {
      throw new AIProviderError("AI 分析内容过长，未能完整生成，请减少选择的项目后重试。", { statusCode: 502, code: "output_truncated" });
    }
    const analysis = normalizeAnalysis(parseJsonContent(completion.content), new Set(prepared.allowedRefs || []));
    const citedRefs = collectAnalysisRefs(analysis);
    analysis.evidenceReferences = (prepared.references || []).filter((reference) => citedRefs.has(reference.ref)).slice(0, 24);
    const output = {
      answer: buildAnswer(analysis),
      analysis,
      meta: {
        mode,
        module: context.tool,
        model: completion.model || this.client.model,
        usage: completion.usage,
        cached: false,
        asOfDate: context.result.query?.asOfDate || "",
        rowCount: context.result.count,
        analyzedRows: mode === "summary" ? prepared.rows.length : prepared.projects.length,
        omittedRows: mode === "summary" ? Number(prepared.distributions?.omittedRows) || 0 : 0,
        complete: Boolean(prepared.completeness?.complete),
        partial: Boolean(prepared.completeness?.partial),
        selectedProjects: selectedCodes,
        contextExpiresAt: context.expiresAt,
      },
    };
    this.contextStore.setCached(context, cacheKey, output, this.config.cacheTtlMs);
    return output;
  }
}

module.exports = {
  AIAnalysisService,
  normalizeAnalysis,
  normalizeRiskLevel,
  parseJsonContent,
  collectAnalysisRefs,
};
