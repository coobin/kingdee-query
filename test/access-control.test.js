const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AccessControl, COOKIE_NAME } = require("../src/access-control");
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

test("matches module access by Chinese name, pinyin account, email local part, or Kingdee account", (t) => {
  const { directory, access } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const chinese = { userId: "240001", name: "张三", email: "zhangsan@example.com", kingdeeUsername: "KD001" };
  access.setModuleAccess({ inventory: ["张三"], sales_orders: ["lisi"] });
  assert.equal(access.canAccess(chinese, "inventory"), true);
  assert.equal(access.canAccess(chinese, "sales_orders"), false);
  access.setModuleAccess({ inventory: ["ZHANGSAN"] });
  assert.equal(access.canAccess(chinese, "inventory"), true);
  access.setModuleAccess({ inventory: ["kd001"] });
  assert.equal(access.canAccess(chinese, "inventory"), true);
});

test("blank access list is open while a super administrator always bypasses module restrictions", (t) => {
  const { directory, access } = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(access.canAccess({ userId: "anyone" }, "inventory"), true);
  access.setModuleAccess({ inventory: ["someone-else"] });
  assert.equal(access.canAccess({ userId: "anyone" }, "inventory"), false);
  assert.equal(access.canAccess({ userId: "admin", isSuperAdmin: true }, "inventory"), true);
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

test("filters the public catalog before it reaches the browser", () => {
  const catalog = {
    inventory: { label: "即时库存", description: "库存", filterFields: {}, fields: [] },
    sales_orders: { label: "销售订单", description: "销售", filterFields: {}, fields: [] },
  };
  const visible = publicCatalog(catalog, false, (id) => id === "sales_orders");
  assert.deepEqual(visible.map((item) => item.id), ["sales_orders"]);
});
