const test = require("node:test");
const assert = require("node:assert/strict");
const { KingdeeClient } = require("../src/kingdee");

const baseConfig = { dbId: "x", appId: "x", appSecret: "x", lcid: 2052, timeoutMs: 1000, sessionTtlMs: 1000 };

test("adds K3Cloud service root to tenant origin", () => {
  const client = new KingdeeClient({ ...baseConfig, baseUrl: "https://tenant.example.com" });
  assert.equal(client.buildUrl("A.B"), "https://tenant.example.com/K3Cloud/A.B.common.kdsvc");
});

test("does not duplicate configured K3Cloud service root", () => {
  const client = new KingdeeClient({ ...baseConfig, baseUrl: "https://tenant.example.com/K3Cloud/" });
  assert.equal(client.buildUrl("A.B"), "https://tenant.example.com/K3Cloud/A.B.common.kdsvc");
});

test("rejects query-service errors wrapped inside an array response", async () => {
  const client = new KingdeeClient({ ...baseConfig, baseUrl: "https://tenant.example.com" });
  client.call = async () => [[{ Result: { ResponseStatus: { IsSuccess: false, Errors: [{ Message: "字段不存在" }] } } }]];
  await assert.rejects(() => client.executeBillQuery("user", { FormId: "AR_RECEIVABLE" }), /字段不存在/);
});
