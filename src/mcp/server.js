const fs = require("node:fs");
const { createHash, timingSafeEqual } = require("node:crypto");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { normalizeIdentifier } = require("../access-control");
const { withQueryDeadline } = require("../kingdee");
const { validDates } = require("./registry");

const toolError = (message) => ({ isError: true, content: [{ type: "text", text: message }] });
const digest = (value) => createHash("sha256").update(value).digest();
const same = (header, token) => timingSafeEqual(digest(String(header || "")), digest("Bearer " + token));
const fault = (status, message) => Object.assign(new Error(message), { status });

function loadMappings(file) {
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(rows)) throw new Error("Invalid MCP identity map");
  const mappings = new Map();
  const accounts = new Set();
  for (const row of rows) {
    if (!row || typeof row.subject !== "string" || !row.subject.trim() ||
        typeof row.kingdeeUsername !== "string" || !row.kingdeeUsername.trim() ||
        typeof row.username !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(row.username)) {
      throw new Error("Invalid MCP identity mapping");
    }
    const account = normalizeIdentifier(row.kingdeeUsername);
    if (mappings.has(row.subject) || accounts.has(account)) throw new Error("Duplicate MCP identity mapping");
    mappings.set(row.subject, row);
    accounts.add(account);
  }
  return mappings;
}

function mountMcp(app, { registry, canAccess, env = process.env, fetchImpl = fetch }) {
  if (env.MCP_ENABLED !== "true") return;
  const { MCP_DIRECTORY_TOKEN: directory, MCP_SERVICE_TOKEN: service, MCP_CENTER_SERVICE_TOKEN: verify,
    MCP_CENTER_INTERNAL_URL: center, MCP_IDENTITY_MAP_PATH: mapPath } = env;
  if ([directory, service, verify].some((key) => !key || key.length < 32) ||
      new Set([directory, service, verify]).size !== 3 || !center || !mapPath) {
    throw new Error("Incomplete MCP configuration or reused credentials");
  }
  const base = new URL(center);
  if (base.protocol !== "https:" && !(env.NODE_ENV === "test" && base.hostname === "127.0.0.1")) {
    throw new Error("MCP_CENTER_INTERNAL_URL requires TLS");
  }
  const endpoint = new URL("/internal/v1/delegated-context", base);
  loadMappings(mapPath);
  const active = new Set();
  const timeout = Number(env.MCP_QUERY_TIMEOUT_MS || 90000);
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 110000) throw new Error("Invalid MCP query timeout");
  const tools = [...registry.values()].map((entry) => entry.tool);

  async function delegated(req) {
    const username = req.get("X-Chency-MCP-User");
    if (req.get("X-Chency-MCP-Delegated") !== "1" || !/^[a-zA-Z0-9._-]{1,100}$/.test(username || "")) {
      throw fault(403, "员工委托无效。");
    }
    let context;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { authorization: "Bearer " + verify, "content-type": "application/json" },
        body: JSON.stringify({ resource: "queryhub", username }),
      });
      if (!response.ok) throw new Error("Unavailable");
      context = await response.json();
    } catch { throw fault(503, "暂时无法核验员工权限。"); }
    if (!context?.active || context.resource !== "queryhub" || context.business_username !== username ||
        !Array.isArray(context.scopes)) throw fault(403, "员工尚未开通金蝶查询。");
    const mapped = loadMappings(mapPath).get(context.subject);
    if (!mapped || mapped.username !== username) throw fault(403, "员工尚未关联金蝶账号。");
    return {
      scopes: new Set(context.scopes),
      identity: { channel: "mcp", userId: username, name: String(context.name || username),
        email: String(context.email || ""), kingdeeUsername: mapped.kingdeeUsername },
    };
  }

  app.get("/internal/mcp/v1/manifest", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!same(req.get("Authorization"), directory)) return res.sendStatus(401);
    const revision = digest(JSON.stringify(tools)).toString("hex");
    res.json({ schemaVersion: 1, systemId: "queryhub", revision, tools });
  });

  app.all("/api/mcp", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.get("Origin")) return res.status(403).json({ error: "不接受浏览器跨站调用。" });
    const auth = req.get("Authorization");
    const isDirectory = same(auth, directory);
    if (!isDirectory && !same(auth, service)) return res.status(401).json({ error: "服务身份无效。" });
    if (req.method !== "POST") return res.sendStatus(405);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = new Server({ name: "金蝶查询", version: "1.0.0" }, { capabilities: { tools: {} } });
    try {
      const context = isDirectory ? null : await delegated(req);
      const allowed = (entry) => context && context.scopes.has(entry.scope) && canAccess(context.identity, entry.id);
      server.setRequestHandler(ListToolsRequestSchema, async (request) => {
        const list = isDirectory ? tools : [...registry.values()].filter(allowed).map((entry) => entry.tool);
        const offset = Number(request.params?.cursor ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > list.length) return { tools: [] };
        const end = offset + 25;
        return { tools: list.slice(offset, end), ...(end < list.length ? { nextCursor: String(end) } : {}) };
      });
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        const entry = registry.get(params.name);
        if (!entry || !allowed(entry) || entry.hash !== req.get("X-Chency-Tool-Revision")) {
          return toolError("该工具未开通、已停用或版本待审核。");
        }
        const args = params.arguments ?? {};
        if (!entry.validate(args) || !validDates(args)) return toolError("请核对查询条件的类型、范围及必填项。");
        const key = context.identity.userId;
        if (active.has(key) || active.size >= 12) return toolError("查询正在处理，请稍后重试。");
        active.add(key);
        req.identity = context.identity;
        try {
          const signal = AbortSignal.timeout(timeout);
          const result = await withQueryDeadline(signal, () => entry.run(req, args));
          if (signal.aborted) return toolError("查询超时，请缩小查询范围后重试。");
          const rows = Array.isArray(result.rows) ? result.rows : null;
          const output = {
            ...result,
            ...(Array.isArray(result.sourceStatus) ? { sourceStatus: result.sourceStatus.map(({ reason, ...status }) => ({
              ...status, ...(reason ? { reason: "该数据来源暂不可用" } : {}),
            })) } : {}),
            aggregationScope: result.aggregate ? (result.aggregate.partial ? "已读取数据" : "本次查询范围")
              : result.statistics ? "本次查询的统计口径，明细可能只显示部分" : "不适用",
            grain: entry.grain, contractVersion: entry.tool._meta["chency/capability"].version, queriedAt: new Date().toISOString(), requestId: req.requestId,
            completeness: result.truncated || result.partial || result.statistics?.partial || result.aggregate?.partial
              ? "partial" : result.truncated === false && !result.statistics ? "complete" : "unknown",
            ...(rows ? { returnedCount: rows.length } : {}),
          };
          const serialized = JSON.stringify(output);
          if (Buffer.byteLength(serialized) > 256 * 1024) {
            return toolError("结果太大，请缩小查询范围后重试。");
          }
          return { structuredContent: output,
            content: [{ type: "text", text: result.summary || "查询完成。" }, { type: "text", text: serialized }] };
        } catch (error) {
          return toolError(error?.statusCode === 404 ? "没有找到该记录，或你无权查看。"
            : error?.statusCode === 400 ? "查询条件不符合该模块要求，请缩小范围或核对筛选条件。"
            : "查询未完成，请稍后重试。");
        } finally { active.delete(key); }
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(error.status || 503).json({ error: error.status ? error.message : "金蝶查询暂不可用。" });
    } finally { await server.close().catch(() => {}); }
  });
}

module.exports = { mountMcp, loadMappings };
