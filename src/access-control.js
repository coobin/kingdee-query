const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COOKIE_NAME = "kqh_admin_session";
const PASSKEY_CHALLENGE_COOKIE = "kqh_passkey_challenge";
const PASSWORD_MIN_LENGTH = 10;

function normalizeIdentifier(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function identityIdentifiers(identity) {
  return new Set([identity?.kingdeeUsername].map(normalizeIdentifier).filter(Boolean));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  validatePassword(password);
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) return false;
  let actual;
  try { actual = crypto.scryptSync(String(password), salt, 64); } catch { return false; }
  const expected = Buffer.from(String(expectedHash), "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH || password.length > 200) {
    throw Object.assign(new Error(`密码长度应为 ${PASSWORD_MIN_LENGTH} 到 200 个字符。`), { statusCode: 400 });
  }
}

function validateAdminUsername(username) {
  const value = String(username || "").normalize("NFKC").trim();
  if (!/^[\p{L}\p{N}_.@-]{2,64}$/u.test(value)) {
    throw Object.assign(new Error("超级管理员用户名应为 2 到 64 位中文、字母、数字或 . _ @ -。"), { statusCode: 400 });
  }
  return value;
}

function cleanText(value, maximum = 100) {
  return String(value || "").normalize("NFKC").trim().slice(0, maximum);
}

function parseCookies(header) {
  return Object.fromEntries(String(header || "").split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    const key = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    try { value = decodeURIComponent(value); } catch { /* preserve malformed value */ }
    return [key, value];
  }).filter(([key]) => key));
}

class AccessControl {
  constructor({ dataPath, sessionHours = 8, cookieSecure = false, moduleIds = [], restrictedModuleIds = [] }) {
    this.dataPath = dataPath;
    this.sessionHours = sessionHours;
    this.cookieSecure = cookieSecure;
    this.moduleIds = [...new Set(moduleIds)];
    this.restrictedModuleIds = new Set(restrictedModuleIds);
    this.sessions = new Map();
    this.passkeyChallenges = new Map();
    this.loginAttempts = new Map();
    this.state = this.load();
  }

  load() {
    let state = { version: 1, admins: [], moduleAccess: {} };
    if (fs.existsSync(this.dataPath)) {
      state = JSON.parse(fs.readFileSync(this.dataPath, "utf8"));
    }
    if (!Array.isArray(state.admins)) state.admins = [];
    if (!state.moduleAccess || typeof state.moduleAccess !== "object") state.moduleAccess = {};
    for (const moduleId of this.moduleIds) {
      if (!Array.isArray(state.moduleAccess[moduleId])) state.moduleAccess[moduleId] = [];
    }
    return state;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
    const temporary = `${this.dataPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.dataPath);
    fs.chmodSync(this.dataPath, 0o600);
  }

  hasAdmins() { return this.state.admins.length > 0; }

  listAdmins() {
    return this.state.admins.map(({ passwordHash, passwordSalt, ...admin }) => ({
      ...admin,
      passwordEnabled: admin.passwordEnabled !== false,
      passkeyOnly: Boolean(admin.passkeyOnly),
      passkeys: (admin.passkeys || []).map(({ id, name, createdAt, transports, credentialDeviceType, credentialBackedUp }) => ({ id, name, createdAt, transports, credentialDeviceType, credentialBackedUp })),
    }));
  }

  createAdmin({ username, displayName, kingdeeUsername, password }) {
    const cleanUsername = validateAdminUsername(username);
    const key = normalizeIdentifier(cleanUsername);
    if (this.state.admins.some((admin) => normalizeIdentifier(admin.username) === key)) {
      throw Object.assign(new Error("该超级管理员用户名已存在。"), { statusCode: 409 });
    }
    const passwordData = hashPassword(password);
    const now = new Date().toISOString();
    this.state.admins.push({
      username: cleanUsername,
      displayName: cleanText(displayName || cleanUsername),
      kingdeeUsername: cleanText(kingdeeUsername),
      passwordSalt: passwordData.salt,
      passwordHash: passwordData.hash,
      passwordEnabled: true,
      passkeyOnly: false,
      passkeys: [],
      createdAt: now,
      updatedAt: now,
    });
    this.persist();
    return this.listAdmins().find((admin) => normalizeIdentifier(admin.username) === key);
  }

  updateAdmin(currentUsername, { displayName, kingdeeUsername, password }) {
    const key = normalizeIdentifier(currentUsername);
    const admin = this.state.admins.find((item) => normalizeIdentifier(item.username) === key);
    if (!admin) throw Object.assign(new Error("没有找到该超级管理员。"), { statusCode: 404 });
    if (displayName != null) admin.displayName = cleanText(displayName || admin.username);
    if (kingdeeUsername != null) admin.kingdeeUsername = cleanText(kingdeeUsername);
    if (password) {
      const passwordData = hashPassword(password);
      admin.passwordSalt = passwordData.salt;
      admin.passwordHash = passwordData.hash;
    }
    admin.updatedAt = new Date().toISOString();
    this.persist();
    return this.listAdmins().find((item) => normalizeIdentifier(item.username) === key);
  }

  deleteAdmin(username) {
    if (this.state.admins.length <= 1) {
      throw Object.assign(new Error("必须至少保留一个超级管理员。"), { statusCode: 400 });
    }
    const key = normalizeIdentifier(username);
    const index = this.state.admins.findIndex((admin) => normalizeIdentifier(admin.username) === key);
    if (index < 0) throw Object.assign(new Error("没有找到该超级管理员。"), { statusCode: 404 });
    const [removed] = this.state.admins.splice(index, 1);
    this.revokeAdminSessions(removed.username);
    this.persist();
  }

  authenticate(username, password) {
    const key = normalizeIdentifier(username);
    const admin = this.state.admins.find((item) => normalizeIdentifier(item.username) === key);
    if (!admin || admin.passwordEnabled === false || admin.passkeyOnly || !verifyPassword(password, admin.passwordSalt, admin.passwordHash)) return null;
    return this.adminIdentity(admin);
  }

  findAdmin(username) {
    const key = normalizeIdentifier(username);
    return this.state.admins.find((admin) => normalizeIdentifier(admin.username) === key) || null;
  }

  findAdminByPasskey(credentialId) {
    const id = String(credentialId || "");
    if (!id) return null;
    for (const admin of this.state.admins) {
      const passkey = (admin.passkeys || []).find((item) => item.id === id);
      if (passkey) return { admin, passkey };
    }
    return null;
  }

  addPasskey(username, credential, name = "未命名 Passkey") {
    const admin = this.findAdmin(username);
    if (!admin) throw Object.assign(new Error("没有找到该超级管理员。"), { statusCode: 404 });
    if (!Array.isArray(admin.passkeys)) admin.passkeys = [];
    if (admin.passkeys.some((item) => item.id === credential.id)) {
      throw Object.assign(new Error("这个 Passkey 已经注册过了。"), { statusCode: 409 });
    }
    if (admin.passkeys.length >= 10) {
      throw Object.assign(new Error("每个超级管理员最多注册 10 个 Passkey。"), { statusCode: 400 });
    }
    const now = new Date().toISOString();
    admin.passkeys.push({ ...credential, name: cleanText(name || "未命名 Passkey", 80), createdAt: now });
    this.persist();
    return this.listAdmins().find((item) => normalizeIdentifier(item.username) === normalizeIdentifier(username));
  }

  removePasskey(username, credentialId) {
    const admin = this.findAdmin(username);
    if (!admin) throw Object.assign(new Error("没有找到该超级管理员。"), { statusCode: 404 });
    if (!Array.isArray(admin.passkeys)) admin.passkeys = [];
    if (admin.passkeyOnly && admin.passkeys.length <= 1) {
      throw Object.assign(new Error("仅 Passkey 登录的管理员至少要保留一个 Passkey。"), { statusCode: 400 });
    }
    const before = admin.passkeys.length;
    admin.passkeys = admin.passkeys.filter((item) => item.id !== credentialId);
    if (admin.passkeys.length === before) throw Object.assign(new Error("没有找到该 Passkey。"), { statusCode: 404 });
    this.persist();
    return this.listAdmins().find((item) => normalizeIdentifier(item.username) === normalizeIdentifier(username));
  }

  updatePasskeyCounter(username, credentialId, counter) {
    const admin = this.findAdmin(username);
    const passkey = admin?.passkeys?.find((item) => item.id === credentialId);
    if (!passkey) throw Object.assign(new Error("没有找到该 Passkey。"), { statusCode: 404 });
    if (Number.isFinite(Number(counter))) passkey.counter = Number(counter);
    this.persist();
  }

  setPasskeyOnly(username, enabled) {
    const admin = this.findAdmin(username);
    if (!admin) throw Object.assign(new Error("没有找到该超级管理员。"), { statusCode: 404 });
    if (enabled && !(admin.passkeys || []).length) {
      throw Object.assign(new Error("请先注册至少一个 Passkey，再关闭密码登录。"), { statusCode: 400 });
    }
    admin.passkeyOnly = Boolean(enabled);
    admin.passwordEnabled = !admin.passkeyOnly;
    admin.updatedAt = new Date().toISOString();
    this.persist();
    return this.listAdmins().find((item) => normalizeIdentifier(item.username) === normalizeIdentifier(username));
  }

  createPasskeyChallenge({ type, adminUsername, challenge, ttlMs = 120000 }) {
    this.cleanupPasskeyChallenges();
    const token = crypto.randomBytes(32).toString("base64url");
    this.passkeyChallenges.set(token, { type, adminUsername, challenge, expiresAt: Date.now() + ttlMs });
    return token;
  }

  consumePasskeyChallenge(cookieHeader, type) {
    this.cleanupPasskeyChallenges();
    const token = parseCookies(cookieHeader)[PASSKEY_CHALLENGE_COOKIE];
    const challenge = token ? this.passkeyChallenges.get(token) : null;
    if (!challenge || challenge.type !== type || challenge.expiresAt <= Date.now()) return null;
    this.passkeyChallenges.delete(token);
    return challenge;
  }

  cleanupPasskeyChallenges() {
    for (const [token, challenge] of this.passkeyChallenges) {
      if (challenge.expiresAt <= Date.now()) this.passkeyChallenges.delete(token);
    }
  }

  adminIdentity(admin) {
    return {
      userId: admin.username,
      name: admin.displayName || admin.username,
      email: "",
      kingdeeUsername: admin.kingdeeUsername || admin.username,
      adminUsername: admin.username,
      isSuperAdmin: true,
      passkeyOnly: Boolean(admin.passkeyOnly),
      channel: "local_admin",
    };
  }

  createSession(identity) {
    this.cleanupSessions();
    const token = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(token, { identity, expiresAt: Date.now() + this.sessionHours * 3600000 });
    return token;
  }

  readSession(cookieHeader) {
    this.cleanupSessions();
    const token = parseCookies(cookieHeader)[COOKIE_NAME];
    if (!token) return null;
    const session = this.sessions.get(token);
    return session?.expiresAt > Date.now() ? { ...session.identity } : null;
  }

  revokeSession(cookieHeader) {
    const token = parseCookies(cookieHeader)[COOKIE_NAME];
    if (token) this.sessions.delete(token);
  }

  revokeAdminSessions(username) {
    const key = normalizeIdentifier(username);
    for (const [token, session] of this.sessions) {
      if (normalizeIdentifier(session.identity.adminUsername) === key) this.sessions.delete(token);
    }
  }

  cleanupSessions() {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= Date.now()) this.sessions.delete(token);
    }
  }

  sessionCookie(token) {
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.sessionHours * 3600)}${this.cookieSecure ? "; Secure" : ""}`;
  }

  clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.cookieSecure ? "; Secure" : ""}`;
  }

  passkeyChallengeCookie(token) {
    return `${PASSKEY_CHALLENGE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=120${this.cookieSecure ? "; Secure" : ""}`;
  }

  clearPasskeyChallengeCookie() {
    return `${PASSKEY_CHALLENGE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.cookieSecure ? "; Secure" : ""}`;
  }

  isLoginBlocked(key) {
    const attempt = this.loginAttempts.get(key);
    if (!attempt || attempt.resetAt <= Date.now()) return false;
    return attempt.count >= 5;
  }

  recordLoginFailure(key) {
    const now = Date.now();
    const current = this.loginAttempts.get(key);
    const attempt = !current || current.resetAt <= now ? { count: 0, resetAt: now + 15 * 60000 } : current;
    attempt.count += 1;
    this.loginAttempts.set(key, attempt);
  }

  clearLoginFailures(key) { this.loginAttempts.delete(key); }

  getModuleAccess() {
    return Object.fromEntries(this.moduleIds.map((moduleId) => [moduleId, [...(this.state.moduleAccess[moduleId] || [])]]));
  }

  setModuleAccess(moduleAccess) {
    for (const moduleId of this.moduleIds) {
      if (!(moduleId in moduleAccess)) continue;
      if (!Array.isArray(moduleAccess[moduleId])) throw Object.assign(new Error("模块人员名单格式不正确。"), { statusCode: 400 });
      const unique = [...new Map(moduleAccess[moduleId].map((value) => {
        const display = cleanText(value, 100);
        return [normalizeIdentifier(display), display];
      }).filter(([key]) => key)).values()];
      if (unique.length > 200) throw Object.assign(new Error("每个模块最多配置 200 人。"), { statusCode: 400 });
      this.state.moduleAccess[moduleId] = unique;
    }
    this.persist();
    return this.getModuleAccess();
  }

  canAccess(identity, moduleId) {
    if (identity?.isSuperAdmin) return true;
    const allowed = this.state.moduleAccess[moduleId] || [];
    if (!allowed.length) return !this.restrictedModuleIds.has(moduleId);
    const identifiers = identityIdentifiers(identity);
    return allowed.some((value) => identifiers.has(normalizeIdentifier(value)));
  }
}

module.exports = {
  AccessControl,
  COOKIE_NAME,
  PASSWORD_MIN_LENGTH,
  PASSKEY_CHALLENGE_COOKIE,
  normalizeIdentifier,
  identityIdentifiers,
  hashPassword,
  verifyPassword,
  parseCookies,
};
