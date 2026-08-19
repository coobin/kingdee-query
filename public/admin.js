const state = { settings: null, auditEvents: [] };
const moduleGrid = document.querySelector("#module-grid");
const adminList = document.querySelector("#admin-list");
const accessMessage = document.querySelector("#access-message");
const adminMessage = document.querySelector("#admin-message");
const auditMessage = document.querySelector("#audit-message");
const auditRows = document.querySelector("#audit-rows");
const auditSearch = document.querySelector("#audit-search");
const auditAction = document.querySelector("#audit-action");

const ACTION_LABELS = {
  login: "登录系统",
  logout: "退出系统",
  "passkey.login": "Passkey 登录",
  query: "数据查询",
  "module_access.update": "修改模块权限",
  "admin.create": "新增管理员",
  "admin.update": "修改管理员",
  "admin.delete": "删除管理员",
  "passkey.register": "注册 Passkey",
  "passkey.remove": "删除 Passkey",
  "passkey.policy.update": "修改登录策略",
};

const TOOL_LABELS = {
  inventory: "即时库存",
  inventory_cycle: "库存周期",
  sales_orders: "销售订单",
  overdue_receivables: "发票账龄",
  receivable_aging: "应收账龄",
  overdue_risk_combined: "超期风险合并",
  purchase_orders: "采购订单",
  expense_claims: "本人费用报销",
  workflow_progress: "审批进度",
};

initialize();

async function initialize() {
  try {
    state.settings = await api("/api/admin/settings");
    document.querySelector("#current-admin").textContent = state.settings.currentAdmin;
    renderModules();
    renderAdmins();
    await loadAudit();
  } catch (error) {
    if (error.status === 401 || error.status === 403) location.assign("/login?next=/admin");
    else showMessage(accessMessage, error.message, true);
  }
}

async function loadAudit() {
  const button = document.querySelector("#refresh-audit");
  button.disabled = true;
  auditMessage.hidden = true;
  try {
    const payload = await api("/api/admin/audit?limit=500");
    state.auditEvents = Array.isArray(payload.events) ? payload.events : [];
    renderAudit();
  } catch (error) {
    showMessage(auditMessage, `日志读取失败：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

function renderAudit() {
  const keyword = auditSearch.value.trim().toLocaleLowerCase("zh-CN");
  const category = auditAction.value;
  const events = state.auditEvents.filter((event) => {
    if (category === "login" && !["login", "logout", "passkey.login"].includes(event.action)) return false;
    if (category === "query" && event.action !== "query") return false;
    if (category === "admin" && ["login", "logout", "passkey.login", "query"].includes(event.action)) return false;
    if (!keyword) return true;
    return auditSearchText(event).includes(keyword);
  });
  document.querySelector("#audit-count").textContent = `显示 ${events.length} / ${state.auditEvents.length} 条`;
  if (!events.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td"); cell.colSpan = 6; cell.className = "audit-empty"; cell.textContent = "没有符合条件的操作日志。";
    row.append(cell); auditRows.replaceChildren(row); return;
  }
  auditRows.replaceChildren(...events.map(renderAuditRow));
}

function renderAuditRow(event) {
  const row = document.createElement("tr");
  row.append(
    auditCell(formatAuditTime(event.ts), "audit-time"),
    auditIdentityCell(event),
    auditCell(ACTION_LABELS[event.action] || event.action || "其他操作"),
    auditCell(auditDetail(event), "audit-detail"),
    auditOutcomeCell(event),
    auditCell(event.ip || "—", "audit-ip"),
  );
  return row;
}

function auditCell(value, className = "") {
  const cell = document.createElement("td"); cell.textContent = value; if (className) cell.className = className; return cell;
}

function auditIdentityCell(event) {
  const cell = document.createElement("td"); cell.className = "audit-person";
  const name = document.createElement("strong"); name.textContent = event.userName || event.user || "未知用户";
  const identifiers = [...new Set([event.user, event.userId].filter((value) => value && value !== event.userName))];
  const account = document.createElement("small"); account.textContent = identifiers.join(" · ") || event.channel || "";
  cell.append(name, account); return cell;
}

function auditOutcomeCell(event) {
  const cell = document.createElement("td");
  const badge = document.createElement("span"); badge.className = `audit-outcome ${event.outcome === "success" ? "success" : "error"}`; badge.textContent = event.outcome === "success" ? "成功" : "失败";
  cell.append(badge);
  if (event.action === "query" && event.outcome === "success") {
    const count = document.createElement("small"); count.textContent = ` ${Number(event.count) || 0} 条 · ${Number(event.durationMs) || 0} ms`; cell.append(count);
  } else if (event.error) {
    const error = document.createElement("small"); error.textContent = ` ${event.error}`; cell.append(error);
  }
  return cell;
}

function auditDetail(event) {
  if (event.action === "query") {
    const tool = TOOL_LABELS[event.tool] || event.tool || "未知模块";
    const detail = event.question || readableArguments(event.arguments);
    return detail ? `${tool}：${detail}` : tool;
  }
  if (event.target) return `对象：${event.target}`;
  if (event.action === "login" || event.action === "passkey.login") return event.channel === "browser" ? "SSO 进入查询台" : "进入管理后台";
  return "—";
}

function readableArguments(value) {
  if (!value || typeof value !== "object" || !Object.keys(value).length) return "";
  return Object.entries(value).map(([key, item]) => `${key}=${String(item)}`).join("，");
}

function auditSearchText(event) {
  return [event.userName, event.user, event.userId, event.ip, event.action, event.tool, event.question, event.error, readableArguments(event.arguments)].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
}

function formatAuditTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || "") : date.toLocaleString("zh-CN", { hour12: false });
}

document.querySelector("#refresh-audit").addEventListener("click", loadAudit);
auditSearch.addEventListener("input", renderAudit);
auditAction.addEventListener("change", renderAudit);

function renderModules() {
  moduleGrid.replaceChildren(...state.settings.modules.map((module, index) => {
    const card = document.createElement("article");
    card.className = "module-card";
    card.dataset.moduleId = module.id;
    const head = document.createElement("div"); head.className = "module-card-head";
    const number = document.createElement("span"); number.textContent = String(index + 1).padStart(2, "0");
    const title = document.createElement("div");
    const strong = document.createElement("strong"); strong.textContent = module.label;
    const description = document.createElement("small"); description.textContent = module.description;
    title.append(strong, description); head.append(number, title);
    const label = document.createElement("label");
    const labelText = document.createElement("span"); labelText.textContent = module.selfScoped ? "允许查看的金蝶用户（可选）" : "允许查看的金蝶用户";
    const textarea = document.createElement("textarea");
    textarea.rows = 4;
    textarea.placeholder = "例如：张三";
    const hint = document.createElement("small");
    hint.className = "field-hint";
    hint.textContent = module.selfScoped
      ? "该模块只返回本人数据，名单留空时默认向所有已登录用户开放。"
      : "直接填写金蝶用户名；多个用户请每行填写一个，也可以用逗号分隔。";
    textarea.value = (state.settings.moduleAccess[module.id] || []).join("\n");
    textarea.addEventListener("input", () => card.classList.toggle("restricted", Boolean(parsePeople(textarea.value).length)));
    label.append(labelText, textarea, hint); card.append(head, label);
    card.classList.toggle("restricted", Boolean(parsePeople(textarea.value).length));
    return card;
  }));
}

function renderAdmins() {
  adminList.replaceChildren(...state.settings.admins.map((admin) => {
    const card = document.createElement("form");
    card.className = "admin-card";
    card.dataset.username = admin.username;
    const identity = document.createElement("div"); identity.className = "admin-card-identity";
    const avatar = document.createElement("span"); avatar.textContent = [...admin.username][0]?.toUpperCase() || "A";
    const names = document.createElement("div");
    const strong = document.createElement("strong"); strong.textContent = admin.username;
    const small = document.createElement("small"); small.textContent = admin.username === state.settings.currentAdmin ? "当前登录 · 超级管理员" : "超级管理员";
    names.append(strong, small); identity.append(avatar, names);
    const fields = document.createElement("div"); fields.className = "admin-card-fields";
    fields.append(adminField("显示名称", "displayName", admin.displayName), adminField("金蝶账号", "kingdeeUsername", admin.kingdeeUsername, "可选"), adminField("重置密码", "password", "", "留空不修改", "password"));
    const passkeyPanel = renderPasskeyPanel(admin);
    const actions = document.createElement("div"); actions.className = "admin-card-actions";
    const save = document.createElement("button"); save.type = "submit"; save.className = "secondary-action"; save.textContent = "保存修改";
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-action"; remove.textContent = "删除";
    remove.disabled = state.settings.admins.length <= 1 || admin.username === state.settings.currentAdmin;
    remove.title = admin.username === state.settings.currentAdmin ? "不能删除当前登录账号" : "删除超级管理员";
    remove.addEventListener("click", () => deleteAdmin(admin.username)); actions.append(save, remove);
    card.append(identity, fields, passkeyPanel, actions);
    card.addEventListener("submit", (event) => updateAdmin(event, admin.username));
    return card;
  }));
}

function renderPasskeyPanel(admin) {
  const panel = document.createElement("div"); panel.className = "passkey-panel";
  const heading = document.createElement("div"); heading.className = "passkey-panel-heading";
  const title = document.createElement("strong"); title.textContent = "Passkey 登录";
  const mode = document.createElement("small"); mode.textContent = admin.passkeyOnly ? "仅 Passkey" : "密码仍可登录";
  heading.append(title, mode); panel.append(heading);
  const list = document.createElement("div"); list.className = "passkey-list";
  (admin.passkeys || []).forEach((passkey) => {
    const item = document.createElement("span"); item.className = "passkey-chip";
    item.textContent = `${passkey.name || "未命名 Passkey"}${passkey.credentialBackedUp ? " · 已同步" : ""}`;
    if (admin.username === state.settings.currentAdmin) {
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = "删除这个 Passkey";
      remove.addEventListener("click", () => removePasskey(passkey.id)); item.append(remove);
    }
    list.append(item);
  });
  if (!(admin.passkeys || []).length) {
    const empty = document.createElement("small"); empty.className = "passkey-empty"; empty.textContent = "尚未注册 Passkey"; list.append(empty);
  }
  panel.append(list);
  const actions = document.createElement("div"); actions.className = "passkey-actions";
  const isCurrent = admin.username === state.settings.currentAdmin;
  if (isCurrent && state.settings.passkey?.available && window.kqhPasskey) {
    const register = document.createElement("button"); register.type = "button"; register.className = "secondary-action"; register.textContent = "注册 Passkey";
    register.addEventListener("click", () => registerPasskey(register)); actions.append(register);
    if ((admin.passkeys || []).length) {
      const policy = document.createElement("button"); policy.type = "button"; policy.className = "secondary-action"; policy.textContent = admin.passkeyOnly ? "恢复密码登录" : "关闭密码登录";
      policy.addEventListener("click", () => updatePasskeyPolicy(policy, !admin.passkeyOnly)); actions.append(policy);
    }
  } else if (isCurrent && !state.settings.passkey?.available) {
    const hint = document.createElement("small"); hint.className = "passkey-empty"; hint.textContent = "Passkey 需要 HTTPS 域名；请先配置 PASSKEY_ORIGIN。"; actions.append(hint);
  } else if ((admin.passkeys || []).length) {
    const hint = document.createElement("small"); hint.className = "passkey-empty"; hint.textContent = "请该管理员本人登录后管理 Passkey。"; actions.append(hint);
  }
  panel.append(actions);
  return panel;
}

async function registerPasskey(button) {
  const name = prompt("给这个 Passkey 起个名字，例如：办公室电脑");
  if (name == null) return;
  button.disabled = true;
  try {
    const payload = await api("/api/admin/passkeys/register/options", { method: "POST", body: JSON.stringify({ username: state.settings.currentAdmin }) });
    const credential = await navigator.credentials.create({ publicKey: window.kqhPasskey.registrationOptions(payload.options) });
    if (!credential) throw new Error("没有取得 Passkey 凭据。");
    await api("/api/admin/passkeys/register/verify", { method: "POST", body: JSON.stringify({ name, credential: window.kqhPasskey.credentialToJSON(credential) }) });
    await reloadSettings();
    showMessage(adminMessage, "Passkey 已注册。", false);
  } catch (error) { showMessage(adminMessage, error.message || "Passkey 注册没有完成。", true); }
  finally { button.disabled = false; }
}

async function removePasskey(id) {
  if (!confirm("确定删除这个 Passkey？删除后需要使用其他 Passkey 或密码登录。")) return;
  try {
    await api(`/api/admin/passkeys/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ username: state.settings.currentAdmin }) });
    await reloadSettings();
    showMessage(adminMessage, "Passkey 已删除。", false);
  } catch (error) { showMessage(adminMessage, error.message, true); }
}

async function updatePasskeyPolicy(button, passkeyOnly) {
  const message = passkeyOnly ? "关闭密码登录后，只能使用 Passkey 登录。确定继续？" : "恢复密码登录？";
  if (!confirm(message)) return;
  button.disabled = true;
  try {
    await api(`/api/admin/admins/${encodeURIComponent(state.settings.currentAdmin)}/passkey-policy`, { method: "PUT", body: JSON.stringify({ passkeyOnly }) });
    await reloadSettings();
    showMessage(adminMessage, passkeyOnly ? "已关闭密码登录。" : "已恢复密码登录。", false);
  } catch (error) { showMessage(adminMessage, error.message, true); }
  finally { button.disabled = false; }
}

function adminField(labelText, name, value, placeholder = "", type = "text") {
  const label = document.createElement("label");
  const span = document.createElement("span"); span.textContent = labelText;
  const input = document.createElement("input"); input.name = name; input.type = type; input.value = value || ""; input.placeholder = placeholder; input.maxLength = type === "password" ? 200 : 100; input.autocomplete = "off";
  if (type === "password") input.minLength = 10;
  label.append(span, input); return label;
}

document.querySelector("#save-access").addEventListener("click", async () => {
  const button = document.querySelector("#save-access");
  button.disabled = true;
  try {
    const moduleAccess = Object.fromEntries([...moduleGrid.querySelectorAll(".module-card")].map((card) => [card.dataset.moduleId, parsePeople(card.querySelector("textarea").value)]));
    const payload = await api("/api/admin/module-access", { method: "PUT", body: JSON.stringify({ moduleAccess }) });
    state.settings.moduleAccess = payload.moduleAccess;
    renderModules();
    showMessage(accessMessage, "模块权限已保存。", false);
  } catch (error) { showMessage(accessMessage, error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector("#create-admin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const values = Object.fromEntries(new FormData(form));
  button.disabled = true;
  try {
    await api("/api/admin/admins", { method: "POST", body: JSON.stringify(values) });
    form.reset();
    await reloadSettings();
    showMessage(adminMessage, `超级管理员 ${values.username} 已新增。`, false);
  } catch (error) { showMessage(adminMessage, error.message, true); }
  finally { button.disabled = false; }
});

async function updateAdmin(event, username) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const values = Object.fromEntries(new FormData(form));
  if (!values.password) delete values.password;
  button.disabled = true;
  try {
    await api(`/api/admin/admins/${encodeURIComponent(username)}`, { method: "PUT", body: JSON.stringify(values) });
    await reloadSettings();
    showMessage(adminMessage, `超级管理员 ${username} 已更新。`, false);
  } catch (error) { showMessage(adminMessage, error.message, true); }
  finally { button.disabled = false; }
}

async function deleteAdmin(username) {
  if (!confirm(`确定删除超级管理员 ${username}？该用户的登录会话会立即失效。`)) return;
  try {
    await api(`/api/admin/admins/${encodeURIComponent(username)}`, { method: "DELETE" });
    await reloadSettings();
    showMessage(adminMessage, `超级管理员 ${username} 已删除。`, false);
  } catch (error) { showMessage(adminMessage, error.message, true); }
}

document.querySelector("#logout-button").addEventListener("click", async () => {
  const button = document.querySelector("#logout-button");
  button.disabled = true;
  try {
    await api("/api/local-auth/logout", { method: "POST", body: "{}" });
    location.assign("/");
  } catch (error) {
    button.disabled = false;
    showMessage(accessMessage, `退出失败：${error.message}`, true);
  }
});

async function reloadSettings() {
  state.settings = await api("/api/admin/settings");
  renderAdmins();
}

function parsePeople(value) {
  return [...new Set(String(value || "").split(/[\n,，;；]+/).map((part) => part.trim()).filter(Boolean))];
}

function showMessage(element, message, isError) {
  element.textContent = message; element.classList.toggle("error", isError); element.hidden = false;
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.message || `请求失败 (${response.status})`), { status: response.status });
  return payload;
}
