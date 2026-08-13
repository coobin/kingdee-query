const express = require("express");
const path = require("path");
const crypto = require("crypto");
const config = require("./src/config");
const { browserAuth, difyAuth, requireSuperAdmin, requireSameOrigin } = require("./src/auth");
const { loadCatalog, publicCatalog } = require("./src/catalog");
const { createAuditLogger } = require("./src/audit");
const { AccessControl, normalizeIdentifier } = require("./src/access-control");
const { KingdeeClient, KingdeeError } = require("./src/kingdee");
const { QueryEngine } = require("./src/query-engine");
const { aiPlan } = require("./src/planner");

const catalog = loadCatalog(config.catalogPath);
const moduleIds = [...Object.keys(catalog), "workflow_progress"];
const accessControl = new AccessControl({ ...config.localAuth, moduleIds });
const kingdee = new KingdeeClient(config.kingdee);
const engine = new QueryEngine({ catalog, kingdee, config });
const audit = createAuditLogger(config.auditPath);
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

app.get("/healthz", (req, res) => res.json({ ok: true, service: "kingdee-query-hub", workflowQuery: Boolean(config.kingdee.workflowMethod) }));
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
    return res.status(429).json({ error: "login_rate_limited", message: "登录失败次数过多，请 15 分钟后再试。" });
  }
  const identity = accessControl.authenticate(username, password);
  if (!identity) {
    accessControl.recordLoginFailure(attemptKey);
    audit({ requestId: req.requestId, outcome: "error", channel: "local_admin", user: normalizeIdentifier(username), action: "login", error: "invalid_credentials", ip: req.ip });
    return res.status(401).json({ error: "invalid_credentials", message: "用户名或密码不正确。" });
  }
  accessControl.clearLoginFailures(attemptKey);
  const token = accessControl.createSession(identity);
  res.setHeader("Set-Cookie", accessControl.sessionCookie(token));
  audit({ requestId: req.requestId, outcome: "success", channel: "local_admin", user: identity.adminUsername, action: "login", ip: req.ip });
  res.json({ ok: true, user: publicIdentity(identity), redirect: "/admin" });
});

app.post("/api/local-auth/logout", requireSameOrigin, (req, res) => {
  accessControl.revokeSession(req.headers.cookie);
  res.setHeader("Set-Cookie", accessControl.clearCookie());
  res.json({ ok: true, redirect: "/login" });
});

const web = express.Router();
web.use(browserAuth(config, accessControl));
web.get("/session", (req, res) => res.json({ user: publicIdentity(req.identity), aiPlanner: Boolean(config.ai.model) }));
web.get("/catalog", (req, res) => res.json({ tools: publicCatalog(catalog, Boolean(config.kingdee.workflowMethod), (moduleId) => accessControl.canAccess(req.identity, moduleId)) }));
web.post("/query", asyncRoute(async (req, res) => {
  const question = String(req.body?.question || "").slice(0, 1000);
  const plan = req.body?.tool ? { tool: req.body.tool, arguments: req.body.arguments || {}, source: "explicit" } : await aiPlan(question, catalog, config);
  enforceModuleAccess(req.identity, plan.tool);
  const result = await executeAndAudit(req, plan, question);
  res.json({ plan, result, requestId: req.requestId });
}));

const admin = express.Router();
admin.use(browserAuth(config, accessControl), requireSuperAdmin);
admin.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
admin.get("/settings", (req, res) => res.json({
  currentAdmin: req.identity.adminUsername,
  admins: accessControl.listAdmins(),
  modules: moduleIds.map((id) => ({ id, label: id === "workflow_progress" ? "审批进度" : catalog[id].label, description: id === "workflow_progress" ? "查询单据当前审批节点和历史" : catalog[id].description })),
  moduleAccess: accessControl.getModuleAccess(),
}));
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
dify.get("/catalog", (req, res) => res.json({ tools: publicCatalog(catalog, Boolean(config.kingdee.workflowMethod), (moduleId) => accessControl.canAccess(req.identity, moduleId)) }));
dify.post("/query", asyncRoute(async (req, res) => {
  const question = String(req.body?.query || req.body?.question || "").slice(0, 1000);
  const plan = req.body?.tool
    ? { tool: req.body.tool, arguments: req.body.arguments || {}, source: "dify-explicit" }
    : await aiPlan(question, catalog, config);
  enforceModuleAccess(req.identity, plan.tool);
  const result = await executeAndAudit(req, plan, question);
  res.json({ answer: result.summary, data: result, plan, request_id: req.requestId });
}));
app.use("/api/dify/v1", dify);
app.use("/api", web);

app.get("/openapi.json", (req, res) => res.json(require("./src/openapi")(config)));

async function executeAndAudit(req, plan, question) {
  const started = Date.now();
  try {
    const result = await engine.execute(req.identity, plan);
    audit({ requestId: req.requestId, outcome: "success", channel: req.identity.channel, user: req.identity.kingdeeUsername, tool: plan.tool, arguments: sanitizeArguments(plan.arguments), question, count: result.count, durationMs: Date.now() - started, ip: req.ip });
    return result;
  } catch (error) {
    audit({ requestId: req.requestId, outcome: "error", channel: req.identity.channel, user: req.identity.kingdeeUsername, tool: plan.tool, arguments: sanitizeArguments(plan.arguments), question, error: error.message, durationMs: Date.now() - started, ip: req.ip });
    throw error;
  }
}

function publicIdentity(identity) {
  return { userId: identity.userId, name: identity.name, email: identity.email, kingdeeUsername: identity.kingdeeUsername, isSuperAdmin: Boolean(identity.isSuperAdmin), adminUsername: identity.adminUsername || "" };
}
function enforceModuleAccess(identity, moduleId) {
  if (!accessControl.canAccess(identity, moduleId)) throw Object.assign(new Error("你没有查看该模块的权限。"), { statusCode: 403 });
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
