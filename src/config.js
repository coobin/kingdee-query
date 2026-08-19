const path = require("path");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function number(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value)) throw new Error(`Invalid number for ${name}`);
  return value;
}

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const authMode = process.env.AUTH_MODE || "trusted_headers";
if (!new Set(["trusted_headers", "dev"]).has(authMode)) {
  throw new Error("AUTH_MODE must be trusted_headers or dev");
}
if (authMode === "dev" && process.env.NODE_ENV === "production") {
  throw new Error("AUTH_MODE=dev is forbidden in production");
}
if (authMode === "trusted_headers" && process.env.NODE_ENV === "production" && !process.env.AUTH_TRUSTED_PROXY_TOKEN) {
  throw new Error("AUTH_TRUSTED_PROXY_TOKEN is required for trusted_headers in production");
}

const appBaseUrl = process.env.APP_BASE_URL || "http://localhost:8092";
let appBase;
try { appBase = new URL(appBaseUrl); } catch { throw new Error("APP_BASE_URL must be a valid URL"); }
const passkeyOriginInput = (process.env.PASSKEY_ORIGIN || appBaseUrl).replace(/\/+$/, "");
let passkeyOriginUrl;
try { passkeyOriginUrl = new URL(passkeyOriginInput); } catch { throw new Error("PASSKEY_ORIGIN must be a valid URL"); }
const passkeyOrigin = `${passkeyOriginUrl.protocol}//${passkeyOriginUrl.host}`;
const passkeySecureContext = passkeyOriginUrl.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(passkeyOriginUrl.hostname);

module.exports = {
  port: number("PORT", 8092),
  appBaseUrl,
  authMode,
  remoteHeaders: {
    user: (process.env.REMOTE_USER_HEADER || "remote-user").toLowerCase(),
    name: (process.env.REMOTE_NAME_HEADER || "remote-name").toLowerCase(),
    email: (process.env.REMOTE_EMAIL_HEADER || "remote-email").toLowerCase(),
    kingdee: (process.env.REMOTE_KINGDEE_USERNAME_HEADER || "remote-kingdee-username").toLowerCase(),
  },
  trustedProxyHeader: (process.env.AUTH_TRUSTED_PROXY_HEADER || "x-auth-proxy-token").toLowerCase(),
  trustedProxyToken: process.env.AUTH_TRUSTED_PROXY_TOKEN || "",
  localAuth: {
    dataPath: process.env.LOCAL_AUTH_DATA_PATH || path.join(__dirname, "..", "data", "access-control.json"),
    sessionHours: Math.min(number("LOCAL_AUTH_SESSION_HOURS", 8), 168),
    cookieSecure: process.env.LOCAL_AUTH_COOKIE_SECURE == null
      ? /^https:/i.test(process.env.APP_BASE_URL || "")
      : bool("LOCAL_AUTH_COOKIE_SECURE"),
  },
  passkey: {
    enabled: bool("PASSKEY_ENABLED", true),
    available: passkeySecureContext,
    origin: passkeyOrigin,
    rpId: process.env.PASSKEY_RP_ID || passkeyOriginUrl.hostname,
    rpName: process.env.PASSKEY_RP_NAME || "Kingdee Query Hub",
  },
  kingdeeUsernameSource: process.env.KINGDEE_USERNAME_SOURCE || "auto",
  difyApiKeys: new Set((process.env.DIFY_API_KEYS || "").split(",").map((x) => x.trim()).filter(Boolean)),
  difyUserHeader: (process.env.DIFY_USER_HEADER || "x-end-user").toLowerCase(),
  scopeAdmins: new Set((process.env.KINGDEE_QUERY_SCOPE_ADMINS || "").split(",").map((x) => x.trim()).filter(Boolean)),
  kingdee: {
    baseUrl: required("KINGDEE_BASE_URL"),
    dbId: required("KINGDEE_DBID"),
    appId: required("KINGDEE_APP_ID"),
    appSecret: required("KINGDEE_APP_SECRET"),
    lcid: number("KINGDEE_LCID", 2052),
    loginMode: process.env.KINGDEE_LOGIN_MODE || "app_secret",
    timeoutMs: number("KINGDEE_TIMEOUT_MS", 15000),
    sessionTtlMs: number("KINGDEE_SESSION_TTL_SECONDS", 900) * 1000,
    maxRows: Math.min(number("KINGDEE_MAX_ROWS", 200), 1000),
    queryPageSize: Math.min(number("KINGDEE_QUERY_PAGE_SIZE", 5000), 5000),
    aggregationMaxRows: Math.min(number("KINGDEE_AGGREGATION_MAX_ROWS", 5000), 10000),
  },
  ai: {
    baseUrl: process.env.AI_BASE_URL || "",
    apiKey: process.env.AI_API_KEY || "",
    model: process.env.AI_MODEL || "",
    timeoutMs: number("AI_TIMEOUT_MS", 20000),
  },
  catalogPath: process.env.QUERY_CATALOG_PATH || path.join(__dirname, "..", "config", "query-catalog.json"),
  auditPath: process.env.AUDIT_LOG_PATH || path.join(__dirname, "..", "data", "audit.ndjson"),
  audit: {
    maxBytes: Math.min(Math.max(number("AUDIT_MAX_BYTES", 10 * 1024 * 1024), 1024 * 1024), 100 * 1024 * 1024),
    maxFiles: Math.min(Math.max(Math.floor(number("AUDIT_MAX_FILES", 10)), 1), 50),
  },
  logLevel: process.env.LOG_LEVEL || "info",
  trustProxy: bool("TRUST_PROXY", true),
};
