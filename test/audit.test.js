const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAuditLogger, readAuditEvents } = require("../src/audit");

test("writes structured audit events with restrictive file permissions", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kqh-audit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "audit.ndjson");
  const audit = createAuditLogger(filePath);
  audit({ action: "query", outcome: "success", user: "240001", tool: "inventory", count: 2 });
  const [event] = readAuditEvents(filePath, { limit: 1 });
  assert.equal(event.action, "query");
  assert.equal(event.user, "240001");
  assert.match(event.eventId, /^[0-9a-f-]{36}$/);
  assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("rotates audit files and reads newest events first across files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kqh-audit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "audit.ndjson");
  const audit = createAuditLogger(filePath, { maxBytes: 450, maxFiles: 2 });
  for (let index = 1; index <= 8; index += 1) {
    audit({ action: "query", outcome: "success", user: "240001", sequence: index, question: "查询销售订单" });
  }
  assert.equal(fs.existsSync(`${filePath}.1`), true);
  assert.equal(fs.existsSync(`${filePath}.2`), true);
  const events = readAuditEvents(filePath, { limit: 4, maxFiles: 2 });
  assert.deepEqual(events.map((event) => event.sequence), [8, 7, 6, 5]);
});

test("shows historical query events written before the action field existed", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kqh-audit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "audit.ndjson");
  fs.writeFileSync(filePath, `${JSON.stringify({ ts: "2026-08-19T00:00:00.000Z", tool: "sales_orders", user: "240001" })}\n`);
  assert.equal(readAuditEvents(filePath, { limit: 1 })[0].action, "query");
});
