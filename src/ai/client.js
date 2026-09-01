class AIProviderError extends Error {
  constructor(message, { statusCode = 502, providerStatus = 0, code = "" } = {}) {
    super(message);
    this.name = "AIProviderError";
    this.statusCode = statusCode;
    this.providerStatus = providerStatus;
    this.code = code;
  }
}

function ensureSlash(value) {
  const text = String(value || "");
  return text.endsWith("/") ? text : `${text}/`;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const result = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"]) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return Object.keys(result).length ? result : null;
}

function requestSignal(controller, externalSignal) {
  if (!externalSignal || typeof AbortSignal?.any !== "function") return controller.signal;
  return AbortSignal.any([controller.signal, externalSignal]);
}

async function readCompletionPayload(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AIProviderError("AI 服务返回的数据无法读取。", { code: "invalid_response" });
  }
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new AIProviderError("AI 服务返回了空内容。", { code: "empty_content" });
  }
  return {
    content,
    finishReason: choice.finish_reason || "stop",
    usage: normalizeUsage(payload.usage),
    model: String(payload.model || ""),
  };
}

async function readStreamingPayload(response, onDelta) {
  if (!response.body || typeof response.body.getReader !== "function") {
    return readCompletionPayload(response);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason = "stop";
  let usage = null;
  let model = "";

  const consumeEvent = async (event) => {
    const data = event.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new AIProviderError("AI 流式响应无法解析。", { code: "invalid_stream" });
    }
    model ||= String(payload.model || "");
    usage ||= normalizeUsage(payload.usage);
    const choice = payload.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta) {
      content += delta;
      if (onDelta) await onDelta(delta);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) await consumeEvent(event);
  }
  buffer += decoder.decode();
  if (buffer.trim()) await consumeEvent(buffer);

  if (!content.trim()) throw new AIProviderError("AI 服务返回了空内容。", { code: "empty_content" });
  return { content, finishReason, usage, model };
}

class AIClient {
  constructor(options = {}, fetchImpl = globalThis.fetch) {
    this.baseUrl = String(options.baseUrl || "").trim();
    this.apiKey = String(options.apiKey || "").trim();
    this.model = String(options.model || "").trim();
    this.timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 30000, 5000), 120000);
    this.maxTokens = Math.min(Math.max(Number(options.maxTokens) || 2500, 256), 8000);
    this.fetch = fetchImpl;
  }

  available() {
    return Boolean(this.baseUrl && this.apiKey && this.model && typeof this.fetch === "function");
  }

  endpoint() {
    try {
      return new URL("chat/completions", ensureSlash(this.baseUrl));
    } catch {
      throw new AIProviderError("AI 服务地址配置不正确。", { statusCode: 503, code: "invalid_base_url" });
    }
  }

  async complete({
    systemPrompt,
    userContent,
    temperature = 0.2,
    maxTokens = this.maxTokens,
    stream = false,
    onDelta = null,
    signal: externalSignal = null,
  }) {
    if (!this.available()) {
      throw new AIProviderError("AI 分析尚未启用或缺少模型配置。", { statusCode: 503, code: "not_configured" });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const safeMaxTokens = Math.min(Math.max(Number(maxTokens) || this.maxTokens, 256), 8000);
    try {
      const response = await this.fetch(this.endpoint(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: stream ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2,
          max_tokens: safeMaxTokens,
          stream,
          // The analysis contract needs a short, reliable JSON answer. DeepSeek
          // enables thinking by default, which can spend the output budget on
          // reasoning_content and occasionally leave JSON content empty.
          thinking: { type: "disabled" },
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: String(systemPrompt || "") },
            { role: "user", content: String(userContent || "") },
          ],
        }),
        signal: requestSignal(controller, externalSignal),
      });
      if (!response.ok) {
        throw new AIProviderError(`AI 服务暂时不可用（HTTP ${response.status}）。`, {
          providerStatus: response.status,
          code: response.status === 429 ? "rate_limited" : "provider_http_error",
        });
      }
      return stream ? await readStreamingPayload(response, onDelta) : await readCompletionPayload(response);
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      if (error?.name === "AbortError") {
        throw new AIProviderError("AI 分析等待超时，请稍后重试。", { statusCode: 504, code: "timeout" });
      }
      throw new AIProviderError("AI 服务连接失败，请稍后重试。", { code: "network_error" });
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  AIClient,
  AIProviderError,
  ensureSlash,
  normalizeUsage,
};
