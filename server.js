const express = require("express");
const path = require("path");
const crypto = require("crypto");
const config = require("./src/config");
const { browserAuth, difyAuth, requireSuperAdmin, requireSameOrigin } = require("./src/auth");
const { loadCatalog, publicCatalog } = require("./src/catalog");
const { createAuditLogger, readAuditEvents } = require("./src/audit");
const { AccessControl, normalizeIdentifier } = require("./src/access-control");
const { KingdeeClient, KingdeeError } = require("./src/kingdee");
const { QueryEngine } = require("./src/query-engine");
const { aiPlan } = require("./src/planner");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

const catalog = loadCatalog(config.catalogPath);
const moduleIds = [...Object.keys(catalog), "workflow_progress"];
const restrictedModuleIds = Object.entries(catalog).filter(([, item]) => item.restrictedByDefault).map(([id]) => id);
const accessControl = new AccessControl({ ...config.localAuth, moduleIds, restrictedModuleIds });
const kingdee = new KingdeeClient(config.kingdee);
const engine = new QueryEngine({ catalog, kingdee, config });
const audit = createAuditLogger(config.auditPath, config.audit);
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);
app.use(express.json({ limit: "64kb" }));

app.use((req, res, next) => {
  req.requestId = String(req.headers["x-request-id"] || crypto.randomUUID());
  res.setHeader("X-Request-ID", req.requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  next();
});

app.get("/healthz", (req, res) => res.json({ ok: true, service: "kingdee-query-hub", workflowQuery: true, workflowSource: "WF_ProcInstBill" }));
app.use(express.static(path.join(__dirname, "public"), { index: false, maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
app.get("/login", (req, res) => {
  if (accessControl.readSession(req.headers.cookie)?.isSuperAdmin) return res.redirect(302, "/admin");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "views", "login.html"));
});
app.get("/admin", (req, res) => {
  const identity = accessControl.readSession(req.headers.cookie);
  if (!identity?.isSuperAdmin) return res.redirect(302, "/login?next=/admin");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "views", "admin.html"));
});
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.post("/api/local-auth/login", requireSameOrigin, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const username = String(req.body?.username || "").slice(0, 100);
  const password = String(req.body?.password || "").slice(0, 300);
  const attemptKey = `${req.ip}:${normalizeIdentifier(username)}`;
  if (accessControl.isLoginBlocked(attemptKey)) {
    audit({ requestId: req.requestId, outcome: "error", channel: "local_admin", user: normalizeIdentifier(username), action: "login", error: "rate_limited", ip: req.ip, userAgent: requestUserAgent(req) });
    return res.status(429).json({ error: "login_rate_limited", message: "登录失败次数过多，请 15 分钟后再试。" });
  }
  const identity = accessControl.authenticate(username, password);
  if (!identity) {
    accessControl.recordLoginFailure(attemptKey);
    audit({ requestId: req.requestId, outcome: "error", channel: "local_admin", user: normalizeIdentifier(username), action: "login", error: "invalid_credentials", ip: req.ip, userAgent: requestUserAgent(req) });
    return res.status(401).json({ error: "invalid_credentials", message: "用户名或密码不正确。" });
  }
  accessControl.clearLoginFailures(attemptKey);
  const token = accessControl.createSession(identity);
  res.setHeader("Set-Cookie", accessControl.sessionCookie(token));
  audit({ requestId: req.requestId, outcome: "success", channel: "local_admin", user: identity.adminUsername, userName: identity.name, action: "login", ip: req.ip, userAgent: requestUserAgent(req) });
  res.json({ ok: true, user: publicIdentity(identity), redirect: "/admin" });
});

app.get("/api/local-auth/passkey/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ enabled: config.passkey.enabled, available: config.passkey.enabled && config.passkey.available, rpName: config.passkey.rpName });
});

app.post("/api/local-auth/passkey/login/options", requireSameOrigin, asyncRoute(async (req, res) => {
  requirePasskeyAvailable();
  const username = String(req.body?.username || "").slice(0, 64);
  const admin = accessControl.findAdmin(username);
  if (!admin || !(admin.passkeys || []).length) {
    throw Object.assign(new Error("该管理员尚未注册 Passkey，或用户名不正确。"), { statusCode: 401 });
  }
  const options = await generateAuthenticationOptions({
    rpID: config.passkey.rpId,
    allowCredentials: admin.passkeys.map((passkey) => ({ id: passkey.id, transports: passkey.transports })),
    userVerification: "required",
  });
  const token = accessControl.createPasskeyChallenge({ type: "login", adminUsername: admin.username, challenge: options.challenge });
  res.setHeader("Set-Cookie", accessControl.passkeyChallengeCookie(token));
  res.json({ options });
}));

app.post("/api/local-auth/passkey/login/verify", requireSameOrigin, asyncRoute(async (req, res) => {
  requirePasskeyAvailable();
  const challenge = accessControl.consumePasskeyChallenge(req.headers.cookie, "login");
  if (!challenge) throw Object.assign(new Error("Passkey 登录已过期，请重新开始。"), { statusCode: 400 });
  const admin = accessControl.findAdmin(challenge.adminUsername);
  const credential = req.body?.credential;
  const stored = admin?.passkeys?.find((passkey) => passkey.id === credential?.id);
  if (!admin || !stored || !credential) throw Object.assign(new Error("Passkey 不属于该管理员。"), { statusCode: 401 });
  const verification = await verifyAuthenticationResponse({
    response: credential,
    expectedChallenge: challenge.challenge,
    expectedOrigin: config.passkey.origin,
    expectedRPID: config.passkey.rpId,
    credential: {
      id: stored.id,
      publicKey: fromBase64Url(stored.publicKey),
      counter: stored.counter,
      transports: stored.transports,
    },
    requireUserVerification: true,
  });
  if (!verification.verified) throw Object.assign(new Error("Passkey 验证未通过。"), { statusCode: 401 });
  accessControl.updatePasskeyCounter(admin.username, stored.id, verification.authenticationInfo.newCounter);
  const identity = accessControl.adminIdentity(accessControl.findAdmin(admin.username));
  const token = accessControl.createSession(identity);
  res.setHeader("Set-Cookie", [accessControl.sessionCookie(token), accessControl.clearPasskeyChallengeCookie()]);
  audit({ requestId: req.requestId, outcome: "success", channel: "local_admin_passkey", user: identity.adminUsername, userName: identity.name, action: "passkey.login", ip: req.ip, userAgent: requestUserAgent(req) });
  res.json({ ok: true, user: publicIdentity(identity), redirect: "/admin" });
}));

app.post("/api/local-auth/logout", requireSameOrigin, (req, res) => {
  const identity = accessControl.readSession(req.headers.cookie);
  accessControl.revokeSession(req.headers.cookie);
  res.setHeader("Set-Cookie", accessControl.clearCookie());
  if (identity) audit({ requestId: req.requestId, outcome: "success", channel: "local_admin", user: identity.adminUsername, userName: identity.name, action: "logout", ip: req.ip, userAgent: requestUserAgent(req) });
  res.json({ ok: true, redirect: "/login" });
});

const web = express.Router();
web.use(browserAuth(config, accessControl));
web.get("/session", (req, res) => {
  if (req.identity.channel === "browser") {
    audit({ ...identityAudit(req), outcome: "success", action: "login" });
  }
  res.json({ user: publicIdentity(req.identity), aiPlanner: Boolean(config.ai.model) });
});
web.get("/catalog", (req, res) => res.json({ tools: publicCatalog(catalog, true, (moduleId) => accessControl.canAccess(req.identity, moduleId)) }));
web.post("/query", asyncRoute(async (req, res) => {
  const question = String(req.body?.question || "").slice(0, 1000);
  const plan = req.body?.tool ? { tool: req.body.tool, arguments: req.body.arguments || {}, source: "explicit" } : await aiPlan(question, catalog, config);
  const result = await executeAndAudit(req, plan, question);
  res.json({ plan, result, requestId: req.requestId });
}));
web.get("/expense-claims/:billNumber/details", asyncRoute(async (req, res) => {
  const result = await executeExpenseDetailsAndAudit(req, req.params.billNumber);
  res.json({ result, requestId: req.requestId });
}));
web.post("/sales-business/:subprojectNumber/details", asyncRoute(async (req, res) => {
  const result = await executeSalesBusinessDetailsAndAudit(req, req.params.subprojectNumber);
  res.json({ result, requestId: req.requestId });
}));

const admin = express.Router();
admin.use(browserAuth(config, accessControl), requireSuperAdmin);
admin.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
admin.get("/settings", (req, res) => res.json({
  currentAdmin: req.identity.adminUsername,
  passkey: { enabled: config.passkey.enabled, available: config.passkey.enabled && config.passkey.available, rpName: config.passkey.rpName },
  admins: accessControl.listAdmins(),
  modules: moduleIds.map((id) => ({
    id,
    label: id === "workflow_progress" ? "审批进度" : catalog[id].label,
    description: id === "workflow_progress" ? "查询单据当前审批节点和历史" : catalog[id].description,
    selfScoped: id === "workflow_progress" || Boolean(catalog[id]?.forceSelfScope),
    restrictedByDefault: Boolean(catalog[id]?.restrictedByDefault),
  })),
  moduleAccess: accessControl.getModuleAccess(),
}));
admin.get("/audit", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  res.json({ events: readAuditEvents(config.auditPath, { limit, maxFiles: config.audit.maxFiles }) });
});
admin.post("/passkeys/register/options", requireSameOrigin, asyncRoute(async (req, res) => {
  requirePasskeyAvailable();
  const target = String(req.body?.username || req.identity.adminUsername).trim();
  if (normalizeIdentifier(target) !== normalizeIdentifier(req.identity.adminUsername)) {
    throw Object.assign(new Error("请由该管理员本人登录后注册 Passkey。"), { statusCode: 403 });
  }
  const admin = accessControl.findAdmin(req.identity.adminUsername);
  const options = await generateRegistrationOptions({
    rpName: config.passkey.rpName,
    rpID: config.passkey.rpId,
    userID: Buffer.from(admin.username),
    userName: admin.username,
    userDisplayName: admin.displayName || admin.username,
    excludeCredentials: (admin.passkeys || []).map((passkey) => ({ id: passkey.id, transports: passkey.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    attestationType: "none",
  });
  const token = accessControl.createPasskeyChallenge({ type: "registration", adminUsername: admin.username, challenge: options.challenge });
  res.setHeader("Set-Cookie", accessControl.passkeyChallengeCookie(token));
  res.json({ options });
}));
admin.post("/passkeys/register/verify", requireSameOrigin, asyncRoute(async (req, res) => {
  requirePasskeyAvailable();
  const challenge = accessControl.consumePasskeyChallenge(req.headers.cookie, "registration");
  if (!challenge) throw Object.assign(new Error("Passkey 注册已过期，请重新开始。"), { statusCode: 400 });
  if (normalizeIdentifier(challenge.adminUsername) !== normalizeIdentifier(req.identity.adminUsername)) {
    throw Object.assign(new Error("请由发起注册的管理员完成验证。"), { statusCode: 403 });
  }
  const verification = await verifyRegistrationResponse({
    response: req.body?.credential,
    expectedChallenge: challenge.challenge,
    expectedOrigin: config.passkey.origin,
    expectedRPID: config.passkey.rpId,
    requireUserVerification: true,
  });
  if (!verification.verified) throw Object.assign(new Error("Passkey 注册验证未通过。"), { statusCode: 400 });
  const credential = verification.registrationInfo.credential;
  const admin = accessControl.addPasskey(challenge.adminUsername, {
    id: credential.id,
    publicKey: toBase64Url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    credentialDeviceType: verification.registrationInfo.credentialDeviceType,
    credentialBackedUp: verification.registrationInfo.credentialBackedUp,
  }, req.body?.name);
  audit({ requestId: req.requestId, outcome: "success", channel: "local_admin", user: req.identity.adminUsername, action: "passkey.register", target: challenge.adminUsername, ip: req.ip });
  res.setHeader("Set-Cookie", accessControl.clearPasskeyChallengeCookie());
  res.json({ ok: true, admin });
}));
admin.delete("/passkeys/:id", requireSameOrigin, (req, res) => {
  const target = String(req.body?.username || req.identity.adminUsername).trim();
  if (normalizeIdentifier(target) !== normalizeIdentifier(req.identity.adminUsername)) {
    throw Object.assign(new Error("请由该管理员本人管理 Passkey。"), { statusCode: 403 });
  }
  const updated = accessControl.removePasskey(req.identity.adminUsername, req.params.id);
  audit({ requestId: req.requestId, outcome: "success", channel: "local_admin", user: req.identity.adminUsername, action: "passkey.remove", target: req.identity.adminUsername, ip: req.ip });
  res.json({ ok: true, admin: updated });
});
admin.put("/admins/:username/passkey-policy", requireSameOrigin, (req, res) => {
  if (normalizeIdentifier(req.params.username) !== normalizeIdentifier(req.identity.adminUsername)) {
    throw Object.assign(new Error("请由该管理员本人切换 Passkey 登录策略。"), { statusCode: 403 });
  }
  const updated = accessControl.setPasskeyOnly(req.identity.adminUsername, req.body?.passkeyOnly === true);
  audit({ requestId: req.requestId, outcome: "success", channel: "local_admin", user: req.identity.adminUsername, action: "passkey.policy.update", target: req.identity.adminUsername, ip: req.ip });
  res.json({ ok: true, admin: updated });
});
admin.put("/module-access", requireSameOrigin, (req, res) => {
  const moduleAccess = accessControl.setModuleAccess(req.body?.moduleAccess || {});
  audit({ requestId: req.requestId, outcome: "success", channel: "local_admin", user: req.identity.adminUsername, action: "module_access.update", ip: req.ip });
  res.json({ ok: true, moduleAccess });
});
admin.post("/admins", requireSameOrigin, (req, res) => {
  const created = accessControl.createAdmin(req.body || {});
  audit({ requestId: req.requestId, outcome: "success", channel: "local_admin", user: req.identity.adminUsername, action: "admin.create", target: created.username, ip: req.ip });
  res.status(201).json({ ok: true, admin: created });
});
admin.put("/admins/:username", requireSameOrigin, (req, res) => {
  const updated = accessControl.updateAdmin(req.params.username, req.body || {});
  audit({ requestId: req.requestId, outcome: "success", channel: "local_admin", user: req.identity.adminUsername, action: "admin.update", target: updated.username, ip: req.ip });
  res.json({ ok: true, admin: updated });
});
admin.delete("/admins/:username", requireSameOrigin, (req, res) => {
  if (normalizeIdentifier(req.params.username) === normalizeIdentifier(req.identity.adminUsername)) {
    throw Object.assign(new Error("不能删除当前正在登录的超级管理员。请先使用其他超级管理员登录。"), { statusCode: 400 });
  }
  accessControl.deleteAdmin(req.params.username);
  audit({ requestId: req.requestId, outcome: "success", channel: "local_admin", user: req.identity.adminUsername, action: "admin.delete", target: req.params.username, ip: req.ip });
  res.json({ ok: true });
});
app.use("/api/admin", admin);

const dify = express.Router();
dify.use(difyAuth(config));
dify.get("/catalog", (req, res) => res.json({ tools: publicCatalog(catalog, true, (moduleId) => accessControl.canAccess(req.identity, moduleId)) }));
dify.post("/query", asyncRoute(async (req, res) => {
  const question = String(req.body?.query || req.body?.question || "").slice(0, 1000);
  const plan = req.body?.tool
    ? { tool: req.body.tool, arguments: req.body.arguments || {}, source: "dify-explicit" }
    : await aiPlan(question, catalog, config);
  const result = await executeAndAudit(req, plan, question);
  res.json({ answer: result.summary, data: result, plan, request_id: req.requestId });
}));
app.use("/api/dify/v1", dify);
app.use("/api", web);

app.get("/openapi.json", (req, res) => res.json(require("./src/openapi")(config)));

async function executeAndAudit(req, plan, question) {
  const started = Date.now();
  try {
    enforceModuleAccess(req.identity, plan.tool);
    const result = await engine.execute(req.identity, plan);
    audit({ ...identityAudit(req), action: "query", outcome: "success", tool: plan.tool, arguments: sanitizeArguments(plan.arguments), question, count: result.count, truncated: Boolean(result.truncated), durationMs: Date.now() - started });
    return result;
  } catch (error) {
    audit({ ...identityAudit(req), action: "query", outcome: "error", tool: plan.tool, arguments: sanitizeArguments(plan.arguments), question, error: error.message, durationMs: Date.now() - started });
    throw error;
  }
}

async function executeExpenseDetailsAndAudit(req, billNumber) {
  const started = Date.now();
  const args = { billNumber: String(billNumber || "").slice(0, 80) };
  try {
    enforceModuleAccess(req.identity, "expense_claims");
    const result = await engine.expenseDetails(req.identity, args.billNumber);
    audit({ ...identityAudit(req), action: "query.detail", outcome: "success", tool: "expense_claims", arguments: args, count: result.count, truncated: Boolean(result.truncated), durationMs: Date.now() - started });
    return result;
  } catch (error) {
    audit({ ...identityAudit(req), action: "query.detail", outcome: "error", tool: "expense_claims", arguments: args, error: error.message, durationMs: Date.now() - started });
    throw error;
  }
}

async function executeSalesBusinessDetailsAndAudit(req, subprojectNumber) {
  const started = Date.now();
  const code = String(subprojectNumber || "").trim().slice(0, 80);
  if (!code) throw Object.assign(new Error("销售子项目编码不正确。"), { statusCode: 400 });
  const body = req.body || {};
  const args = {
    subprojectNumber: code,
    dateFrom: String(body.dateFrom || "").slice(0, 10),
    dateTo: String(body.dateTo || "").slice(0, 10),
    ...(body.customerName ? { customerName: String(body.customerName).slice(0, 80) } : {}),
    ...(body.projectNumber ? { projectNumber: String(body.projectNumber).slice(0, 60) } : {}),
    limit: 1,
  };
  try {
    enforceModuleAccess(req.identity, "sales_business_analysis");
    const result = await engine.salesBusinessAnalysis(req.identity, catalog.sales_business_analysis, args, { includeDetails: true });
    if (!result.rows.length) throw Object.assign(new Error("没有找到这条销售子项目，或当前账号无权查看。"), { statusCode: 404 });
    audit({ ...identityAudit(req), action: "query.detail", outcome: "success", tool: "sales_business_analysis", arguments: sanitizeArguments(args), count: result.count, truncated: Boolean(result.truncated), durationMs: Date.now() - started });
    return result;
  } catch (error) {
    audit({ ...identityAudit(req), action: "query.detail", outcome: "error", tool: "sales_business_analysis", arguments: sanitizeArguments(args), error: error.message, durationMs: Date.now() - started });
    throw error;
  }
}

function publicIdentity(identity) {
  return { userId: identity.userId, name: identity.name, email: identity.email, kingdeeUsername: identity.kingdeeUsername, isSuperAdmin: Boolean(identity.isSuperAdmin), adminUsername: identity.adminUsername || "" };
}
function requirePasskeyAvailable() {
  if (!config.passkey.enabled) throw Object.assign(new Error("Passkey 功能尚未启用。"), { statusCode: 503 });
  if (!config.passkey.available) throw Object.assign(new Error("Passkey 需要 HTTPS 域名，请先配置 PASSKEY_ORIGIN。"), { statusCode: 503 });
}
function toBase64Url(value) { return Buffer.from(value).toString("base64url"); }
function fromBase64Url(value) { return new Uint8Array(Buffer.from(String(value), "base64url")); }
function enforceModuleAccess(identity, moduleId) {
  if (!accessControl.canAccess(identity, moduleId)) throw Object.assign(new Error("你没有查看该模块的权限。"), { statusCode: 403 });
}
function requestUserAgent(req) { return String(req.headers["user-agent"] || "").slice(0, 300); }
function identityAudit(req) {
  return {
    requestId: req.requestId,
    channel: req.identity.channel,
    user: req.identity.kingdeeUsername || req.identity.adminUsername || req.identity.userId,
    userId: req.identity.userId || "",
    userName: req.identity.name || "",
    ip: req.ip,
    userAgent: requestUserAgent(req),
  };
}
function sanitizeArguments(args) { return Object.fromEntries(Object.entries(args || {}).filter(([key]) => !/secret|password|token/i.test(key))); }
function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }

app.use((error, req, res, next) => {
  const status = error.statusCode || (error instanceof KingdeeError ? 502 : 500);
  console.error(JSON.stringify({ level: "error", requestId: req.requestId, message: error.message, details: error instanceof KingdeeError ? error.details : undefined }));
  res.status(status).json({ error: error.name || "Error", message: status === 500 ? "服务暂时无法完成查询。" : error.message, requestId: req.requestId, ...(process.env.NODE_ENV !== "production" && error.details ? { details: error.details } : {}) });
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", message: "server.started", port: config.port, authMode: config.authMode, tools: Object.keys(catalog) }));
});
