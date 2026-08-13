const crypto = require("crypto");

function normalizeHeader(value) {
  let text = Array.isArray(value) ? value[0] || "" : String(value || "");
  text = text.trim();
  if (/%[0-9a-f]{2}/i.test(text)) {
    try { text = decodeURIComponent(text); } catch { /* preserve */ }
  }
  if (!/[\u4e00-\u9fff]/.test(text)) {
    const repaired = Buffer.from(text, "latin1").toString("utf8");
    if (/[\u4e00-\u9fff]/.test(repaired)) text = repaired;
  }
  return text;
}

function resolveKingdeeUsername(user, source) {
  const emailLocal = user.email.includes("@") ? user.email.split("@")[0] : user.email;
  const values = {
    kingdee_header: user.kingdeeUsername,
    remote_user: user.userId,
    remote_name: user.name,
    email: user.email,
    email_localpart: emailLocal,
  };
  if (source !== "auto") return String(values[source] || "").trim();
  return String(user.kingdeeUsername || user.userId || user.email || emailLocal || "").trim();
}

function readTrustedUser(req, config) {
  if (config.authMode === "dev") {
    const userId = normalizeHeader(req.headers[config.remoteHeaders.user]) || "dev";
    return { userId, name: userId, email: "", kingdeeUsername: userId };
  }
  const user = {
    userId: normalizeHeader(req.headers[config.remoteHeaders.user]),
    name: normalizeHeader(req.headers[config.remoteHeaders.name]),
    email: normalizeHeader(req.headers[config.remoteHeaders.email]),
    kingdeeUsername: normalizeHeader(req.headers[config.remoteHeaders.kingdee]),
  };
  if (!user.userId && !user.email && !user.kingdeeUsername) return null;
  user.kingdeeUsername = resolveKingdeeUsername(user, config.kingdeeUsernameSource);
  if (!user.userId) user.userId = user.kingdeeUsername || user.email;
  if (!user.name) user.name = user.userId;
  return user;
}

function browserAuth(config, accessControl) {
  return (req, res, next) => {
    const localAdmin = accessControl?.readSession(req.headers.cookie);
    if (localAdmin) {
      req.identity = localAdmin;
      return next();
    }
    const proxyToken = normalizeHeader(req.headers[config.trustedProxyHeader]);
    if (config.authMode === "trusted_headers" && !safeEqual(proxyToken, config.trustedProxyToken)) {
      return res.status(401).json({
        error: "untrusted_proxy",
        message: "请求没有经过受信任的 SSO 代理。",
      });
    }
    const user = readTrustedUser(req, config);
    if (!user || !user.kingdeeUsername) {
      return res.status(401).json({
        error: "unauthenticated",
        message: "未收到 SSO 身份。请从统一登录入口访问，或检查反向代理的 Remote-* 请求头。",
      });
    }
    req.identity = { ...user, channel: "browser" };
    next();
  };
}

function requireSuperAdmin(req, res, next) {
  if (!req.identity?.isSuperAdmin) {
    return res.status(403).json({ error: "admin_required", message: "需要超级管理员权限。" });
  }
  next();
}

function requireModuleAccess(accessControl, moduleFromRequest) {
  return (req, res, next) => {
    const moduleId = moduleFromRequest(req);
    if (!moduleId || accessControl.canAccess(req.identity, moduleId)) return next();
    return res.status(403).json({ error: "module_forbidden", message: "你没有查看该模块的权限。" });
  };
}

function requireSameOrigin(req, res, next) {
  const origin = String(req.headers.origin || "");
  if (!origin) return next();
  try {
    const originUrl = new URL(origin);
    if (originUrl.host === req.get("host")) return next();
  } catch { /* reject malformed origin */ }
  return res.status(403).json({ error: "invalid_origin", message: "请求来源不受信任。" });
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function difyAuth(config) {
  return (req, res, next) => {
    const authorization = String(req.headers.authorization || "");
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const valid = token && [...config.difyApiKeys].some((key) => safeEqual(token, key));
    if (!valid) {
      return res.status(401).json({ error: "invalid_api_key", message: "Dify API Key 无效。" });
    }
    const user = normalizeHeader(req.headers[config.difyUserHeader] || req.body?.user);
    if (!user) {
      return res.status(400).json({ error: "missing_end_user", message: `必须通过 ${config.difyUserHeader} 请求头或 user 请求字段传入最终用户的金蝶账号。` });
    }
    req.identity = { userId: user, name: user, email: "", kingdeeUsername: user, channel: "dify" };
    next();
  };
}

module.exports = {
  browserAuth,
  difyAuth,
  readTrustedUser,
  resolveKingdeeUsername,
  requireSuperAdmin,
  requireModuleAccess,
  requireSameOrigin,
};
