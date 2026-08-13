const state = { settings: null };
const moduleGrid = document.querySelector("#module-grid");
const adminList = document.querySelector("#admin-list");
const accessMessage = document.querySelector("#access-message");
const adminMessage = document.querySelector("#admin-message");

initialize();

async function initialize() {
  try {
    state.settings = await api("/api/admin/settings");
    document.querySelector("#current-admin").textContent = state.settings.currentAdmin;
    renderModules();
    renderAdmins();
  } catch (error) {
    if (error.status === 401 || error.status === 403) location.assign("/login?next=/admin");
    else showMessage(accessMessage, error.message, true);
  }
}

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
    const labelText = document.createElement("span"); labelText.textContent = "允许查看的金蝶用户";
    const textarea = document.createElement("textarea");
    textarea.rows = 4;
    textarea.placeholder = "例如：张三";
    const hint = document.createElement("small");
    hint.className = "field-hint";
    hint.textContent = "直接填写金蝶用户名；多个用户请每行填写一个，也可以用逗号分隔。";
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
    const actions = document.createElement("div"); actions.className = "admin-card-actions";
    const save = document.createElement("button"); save.type = "submit"; save.className = "secondary-action"; save.textContent = "保存修改";
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger-action"; remove.textContent = "删除";
    remove.disabled = state.settings.admins.length <= 1 || admin.username === state.settings.currentAdmin;
    remove.title = admin.username === state.settings.currentAdmin ? "不能删除当前登录账号" : "删除超级管理员";
    remove.addEventListener("click", () => deleteAdmin(admin.username)); actions.append(save, remove);
    card.append(identity, fields, actions);
    card.addEventListener("submit", (event) => updateAdmin(event, admin.username));
    return card;
  }));
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
