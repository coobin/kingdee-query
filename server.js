const express = require("express");
const path = require("path");
const crypto = require("crypto");
const config = require("./src/config");
const { browserAuth, difyAuth } = require("./src/auth");
const { loadCatalog, publicCatalog } = require("./src/catalog");
const { createAuditLogger } = require("./src/audit");
const { KingdeeClient, KingdeeError } = require("./src/kingdee");
const { QueryEngine } = require("./src/query-engine");
const { aiPlan } = require("./src/planner");

const catalog = loadCatalog(config.catalogPath);
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
  next();
});

app.get("/healthz", (req, res) => res.json({ ok: true, service: "kingdee-query-hub", workflowQuery: Boolean(config.kingdee.workflowMethod) }));
app.use(express.static(path.join(__dirname, "public"), { index: false, maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const web = express.Router();
web.use(browserAuth(config));
web.get("/session", (req, res) => res.json({ user: publicIdentity(req.identity), aiPlanner: Boolean(config.ai.model) }));
web.get("/catalog", (req, res) => res.json({ tools: publicCatalog(catalog, Boolean(config.kingdee.workflowMethod)) }));
web.post("/query", asyncRoute(async (req, res) => {
  const question = String(req.body?.question || "").slice(0, 1000);
  const plan = req.body?.tool ? { tool: req.body.tool, arguments: req.body.arguments || {}, source: "explicit" } : await aiPlan(question, catalog, config);
  const result = await executeAndAudit(req, plan, question);
  res.json({ plan, result, requestId: req.requestId });
}));

const dify = express.Router();
dify.use(difyAuth(config));
dify.get("/catalog", (req, res) => res.json({ tools: publicCatalog(catalog, Boolean(config.kingdee.workflowMethod)) }));
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
    const result = await engine.execute(req.identity, plan);
    audit({ requestId: req.requestId, outcome: "success", channel: req.identity.channel, user: req.identity.kingdeeUsername, tool: plan.tool, arguments: sanitizeArguments(plan.arguments), question, count: result.count, durationMs: Date.now() - started, ip: req.ip });
    return result;
  } catch (error) {
    audit({ requestId: req.requestId, outcome: "error", channel: req.identity.channel, user: req.identity.kingdeeUsername, tool: plan.tool, arguments: sanitizeArguments(plan.arguments), question, error: error.message, durationMs: Date.now() - started, ip: req.ip });
    throw error;
  }
}

function publicIdentity(identity) {
  return { userId: identity.userId, name: identity.name, email: identity.email, kingdeeUsername: identity.kingdeeUsername };
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
