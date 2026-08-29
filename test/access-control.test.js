const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AccessControl, COOKIE_NAME, PASSKEY_CHALLENGE_COOKIE } = require("../src/access-control");
const { publicCatalog } = require("../src/catalog");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kqh-access-"));
  const dataPath = path.join(directory, "access-control.json");
  const access = new AccessControl({ dataPath, moduleIds: ["inventory", "sales_orders"], sessionHours: 8 });
  return { directory, dataPath, access };
}

test("persists a salted password hash and authenticates the administrator", (t) => {
  const { directory, dataPath, access } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const password = "a-secure-password";
  access.createAdmin({ username: "kay", displayName: "Kay", password });
  assert.equal(access.authenticate("KAY", password).isSuperAdmin, true);
  assert.equal(access.authenticate("kay", "wrong-password"), null);
  const persisted = fs.readFileSync(dataPath, "utf8");
  assert.doesNotMatch(persisted, new RegExp(password));
  assert.match(persisted, /passwordHash/);
  assert.equal(fs.statSync(dataPath).mode & 0o777, 0o600);
});

test("creates and reads an administrator session cookie", (t) => {
  const { directory, access } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const admin = access.createAdmin({ username: "kay", password: "a-secure-password" });
  const token = access.createSession(access.adminIdentity({ ...admin, passwordSalt: "", passwordHash: "" }));
  const cookie = access.sessionCookie(token);
  assert.match(cookie, new RegExp(`^${COOKIE_NAME}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(access.readSession(cookie).adminUsername, "kay");
});

test("matches module access only by the SSO-resolved Kingdee username", (t) => {
  const { directory, access } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const employee = { userId: "240001", name: "张三", email: "zhangsan@example.com", kingdeeUsername: "KD001" };
  for (const nonKingdeeIdentifier of ["张三", "zhangsan", "240001", "zhangsan@example.com"]) {
    access.setModuleAccess({ inventory: [nonKingdeeIdentifier] });
    assert.equal(access.canAccess(employee, "inventory"), false);
  }
  access.setModuleAccess({ inventory: ["kd001"] });
  assert.equal(access.canAccess(employee, "inventory"), true);
});

test("normalizes and deduplicates multiline Kingdee user lists", (t) => {
  const { directory, access } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const saved = access.setModuleAccess({ inventory: ["张三", " 张三 ", "李四"] });
  assert.deepEqual(saved.inventory, ["张三", "李四"]);
});

test("blank access list is open while a super administrator always bypasses module restrictions", (t) => {
  const { directory, access } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(access.canAccess({ userId: "anyone" }, "inventory"), true);
  access.setModuleAccess({ inventory: ["someone-else"] });
  assert.equal(access.canAccess({ userId: "anyone" }, "inventory"), false);
  assert.equal(access.canAccess({ userId: "admin", isSuperAdmin: true }, "inventory"), true);
});

test("sensitive modules are closed by default until an explicit Kingdee user is listed", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kqh-access-sensitive-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const access = new AccessControl({
    dataPath: path.join(directory, "access-control.json"),
    moduleIds: ["personnel_cost"],
    restrictedModuleIds: ["personnel_cost"],
  });
  const employee = { kingdeeUsername: "240001" };
  assert.equal(access.canAccess(employee, "personnel_cost"), false);
  assert.equal(access.canAccess({ kingdeeUsername: "admin", isSuperAdmin: true }, "personnel_cost"), true);
  access.setModuleAccess({ personnel_cost: ["240001"] });
  assert.equal(access.canAccess(employee, "personnel_cost"), true);
});

test("prevents deleting the last administrator and keeps the current session after a password change", (t) => {
  const { directory, access } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identity = access.createAdmin({ username: "kay", password: "a-secure-password" });
  const token = access.createSession({ ...identity, adminUsername: "kay", isSuperAdmin: true });
  assert.throws(() => access.deleteAdmin("kay"), /至少保留一个/);
  access.updateAdmin("kay", { password: "another-secure-password" });
  assert.equal(access.readSession(`${COOKIE_NAME}=${token}`).adminUsername, "kay");
  assert.equal(access.authenticate("kay", "another-secure-password").isSuperAdmin, true);
});

test("stores Passkeys, updates counters, and can switch an administrator to Passkey-only login", (t) => {
  const { directory, access } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  access.createAdmin({ username: "kay", password: "a-secure-password" });
  const credential = { id: "credential-1", publicKey: "public-key", counter: 0, transports: ["internal"] };
  access.addPasskey("kay", credential, "办公室电脑");
  assert.equal(access.listAdmins()[0].passkeys[0].name, "办公室电脑");
  access.updatePasskeyCounter("kay", "credential-1", 7);
  assert.equal(access.findAdmin("kay").passkeys[0].counter, 7);
  access.setPasskeyOnly("kay", true);
  assert.equal(access.authenticate("kay", "a-secure-password"), null);
  assert.equal(access.listAdmins()[0].passkeyOnly, true);
  assert.throws(() => access.removePasskey("kay", "credential-1"), /至少要保留一个/);
  access.setPasskeyOnly("kay", false);
  assert.equal(access.authenticate("kay", "a-secure-password").isSuperAdmin, true);
});

test("locates the administrator from a Passkey credential ID", (t) => {
  const { directory, access } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  access.createAdmin({ username: "kay", password: "a-secure-password" });
  access.createAdmin({ username: "admin", password: "another-secure-password" });
  access.addPasskey("admin", { id: "credential-2", publicKey: "public-key", counter: 0 }, "安全钥匙");

  const match = access.findAdminByPasskey("credential-2");
  assert.equal(match.admin.username, "admin");
  assert.equal(match.passkey.id, "credential-2");
  assert.equal(access.findAdminByPasskey("missing"), null);
  assert.equal(access.findAdminByPasskey(""), null);
});

test("requires a Passkey before enabling Passkey-only login", (t) => {
  const { directory, access } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  access.createAdmin({ username: "kay", password: "a-secure-password" });
  assert.throws(() => access.setPasskeyOnly("kay", true), /先注册至少一个 Passkey/);
});

test("stores Passkey challenges as one-time, type-bound cookies", (t) => {
  const { directory, access } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const token = access.createPasskeyChallenge({ type: "login", adminUsername: "kay", challenge: "challenge-1" });
  const cookie = access.passkeyChallengeCookie(token);
  assert.match(cookie, new RegExp(`^${PASSKEY_CHALLENGE_COOKIE}=`));
  assert.equal(access.consumePasskeyChallenge(cookie, "registration"), null);
  assert.deepEqual(access.consumePasskeyChallenge(cookie, "login").challenge, "challenge-1");
  assert.equal(access.consumePasskeyChallenge(cookie, "login"), null);
});

test("filters the public catalog before it reaches the browser", () => {
  const catalog = {
    inventory: { label: "即时库存", description: "库存", filterFields: {}, fields: [] },
    sales_orders: { label: "销售订单", description: "销售", filterFields: {}, fields: [] },
  };
  const visible = publicCatalog(catalog, false, (id) => id === "sales_orders");
  assert.deepEqual(visible.map((item) => item.id), ["sales_orders"]);
});
