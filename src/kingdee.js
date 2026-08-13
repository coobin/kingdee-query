const crypto = require("crypto");

class KingdeeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "KingdeeError";
    this.details = details;
  }
}

class KingdeeClient {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
  }

  buildUrl(method) {
    const parsed = new URL(this.config.baseUrl);
    const currentPath = parsed.pathname.replace(/\/+$/, "");
    const serviceRoot = /\/k3cloud$/i.test(currentPath)
      ? `${currentPath}/`
      : `${currentPath}/K3Cloud/`.replace(/\/{2,}/g, "/");
    parsed.pathname = `${serviceRoot}${method}.common.kdsvc`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }

  async request(method, parameters, cookie = "") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const envelope = {
      format: 1,
      useragent: "Kingdee-Query-Hub",
      rid: crypto.randomUUID(),
      parameters: JSON.stringify(parameters),
      timestamp: new Date().toISOString(),
      v: "1.0",
    };
    try {
      const response = await fetch(this.buildUrl(method), {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Accept: "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = text; }
      if (!response.ok) {
        throw new KingdeeError(`金蝶 WebAPI 返回 HTTP ${response.status}`, { status: response.status, payload });
      }
      const setCookies = typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
      return { payload, cookie: setCookies.map((value) => value.split(";")[0]).join("; ") };
    } catch (error) {
      if (error.name === "AbortError") throw new KingdeeError("金蝶 WebAPI 请求超时");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async login(username) {
    if (!username) throw new KingdeeError("缺少金蝶用户名");
    const existing = this.sessions.get(username);
    if (existing && existing.expiresAt > Date.now()) return existing.cookie;
    if (this.config.loginMode !== "app_secret") {
      throw new KingdeeError(`暂不支持 KINGDEE_LOGIN_MODE=${this.config.loginMode}`);
    }
    const method = "Kingdee.BOS.WebApi.ServicesStub.AuthService.LoginByAppSecret";
    const { payload, cookie } = await this.request(method, [
      this.config.dbId,
      username,
      this.config.appId,
      this.config.appSecret,
      this.config.lcid,
    ]);
    const loginType = Number(payload?.LoginResultType ?? payload?.Result?.LoginResultType);
    if (![1, -5].includes(loginType) || !cookie) {
      throw new KingdeeError("金蝶用户登录失败", { loginType, message: payload?.Message || payload?.MessageCode || payload });
    }
    this.sessions.set(username, { cookie, expiresAt: Date.now() + this.config.sessionTtlMs });
    return cookie;
  }

  async call(username, method, parameters, retry = true) {
    const cookie = await this.login(username);
    const result = await this.request(method, parameters, cookie);
    const lost = result.payload?.ResponseStatus?.MsgCode === 1 || result.payload?.Result?.ResponseStatus?.MsgCode === 1;
    if (lost && retry) {
      this.sessions.delete(username);
      return this.call(username, method, parameters, false);
    }
    return result.payload;
  }

  async executeBillQuery(username, data) {
    const method = "Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteBillQuery";
    const result = await this.call(username, method, [JSON.stringify(data)]);
    if (!Array.isArray(result)) {
      throw new KingdeeError("金蝶查询未返回列表", { payload: result });
    }
    const responseStatus = result?.[0]?.[0]?.Result?.ResponseStatus;
    if (responseStatus?.IsSuccess === false) {
      const message = responseStatus.Errors?.map((error) => error.Message).filter(Boolean).join("；") || "字段或过滤条件无效";
      throw new KingdeeError(`金蝶查询失败：${message}`, { payload: result });
    }
    return result;
  }

  async workflowProgress(username, method, args) {
    if (!method) throw new KingdeeError("尚未配置工作流进度自定义 WebAPI");
    return this.call(username, method, [JSON.stringify(args)]);
  }
}

module.exports = { KingdeeClient, KingdeeError };
