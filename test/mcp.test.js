const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const express = require("express");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { mountMcp } = require("../src/mcp/server");
const { buildRegistry } = require("../src/mcp/registry");
const catalog = require("../config/query-catalog.json");

test("MCP publishes registered tools, enforces directory isolation, version, input and live employee rights", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "queryhub-mcp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "map.json");
  writeFileSync(path, JSON.stringify([{ subject: "test-subject", username: "alice", kingdeeUsername: "erp-alice" }]));
  const app = express();
  app.use(express.json());
  const directory = "d".repeat(32);
  const service = "s".repeat(32);
  const verify = "v".repeat(32);
  let scopes = ["queryhub:inventory:read"];
  let subject = "test-subject";
  let moduleAccess = true;
  let runs = 0;
  const registry = buildRegistry({
    ...catalog,
    future: { label: "测试模块", description: "测试查询", filterFields: {}, mcp: { grain: "测试行" } },
  }, {
    query: (req, id) => {
      assert.equal(req.identity.kingdeeUsername, "erp-alice");
      assert.equal(id, "inventory");
      runs++;
      return { rows: [{ 物料: "TEST" }], truncated: false };
    },
    expense() {}, sales() {},
  });
  mountMcp(app, {
    registry,
    canAccess: () => moduleAccess,
    env: {
      MCP_ENABLED: "true", MCP_DIRECTORY_TOKEN: directory, MCP_SERVICE_TOKEN: service,
      MCP_CENTER_SERVICE_TOKEN: verify, MCP_CENTER_INTERNAL_URL: "https://center.example.test", MCP_IDENTITY_MAP_PATH: path,
    },
    fetchImpl: async (url, init) => {
      assert.equal(url.pathname, "/internal/v1/delegated-context");
      assert.equal(init.headers.authorization, "Bearer " + verify);
      assert.deepEqual(JSON.parse(init.body), { resource: "queryhub", username: "alice" });
      return Response.json({ active: true, subject, business_username: "alice", resource: "queryhub", scopes });
    },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => server.close());
  const base = "http://127.0.0.1:" + server.address().port;
  async function connect(headers) {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp/", base), { requestInit: { headers } }));
    t.after(() => client.close());
    return client;
  }
  const manifest = await fetch(base + "/internal/mcp/v1/manifest", { headers: { authorization: "Bearer " + directory } });
  const discovered = await connect({ authorization: "Bearer " + directory });
  const listed = (await discovered.listTools()).tools;
  assert.equal(listed.length, 16);
  assert.ok(listed.some((tool) => tool.name === "future_query"));
  const tool = listed.find((entry) => entry.name === "inventory_query");
  const rev = tool._meta["chency/capability"].hash;
  assert.equal((await manifest.json()).tools.length, 16);
  const args = { materialNumber: "TEST" };
  const call = (client, input = args) => client.callTool({ name: tool.name, arguments: input });
  assert.equal((await call(discovered)).isError, true);
  const headers = { authorization: "Bearer " + service, "X-Chency-MCP-User": "alice", "X-Chency-MCP-Delegated": "1" };
  const employee = await connect({ ...headers, "X-Chency-Tool-Revision": rev });
  assert.deepEqual((await employee.listTools()).tools.map((t) => t.name), [tool.name]);
  assert.equal((await call(employee, { ...args, user: "bob" })).isError, true);
  assert.equal((await call(employee, { limit: 1 })).isError, true);
  const stale = await connect(headers);
  assert.equal((await call(stale)).isError, true);
  assert.equal((await call(employee)).structuredContent.returnedCount, 1);
  moduleAccess = false;
  assert.deepEqual((await employee.listTools()).tools, []);
  assert.equal((await call(employee)).isError, true);
  moduleAccess = true;
  scopes = [];
  assert.equal((await call(employee)).isError, true);
  subject = "replacement-identity";
  await assert.rejects(employee.listTools());
  assert.equal(runs, 1);
});
