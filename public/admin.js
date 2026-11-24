const state = {
  settings: null,
  auditEvents: [],
  directory: null,
  picker: null,
  moduleView: "modules",
  moduleFilter: "all",
  moduleSearch: "",
  checkedModules: new Set(),
  rosterFilter: "all",
  rosterSearch: "",
};
const moduleRows = document.querySelector("#module-rows");
const rosterRows = document.querySelector("#roster-rows");
const moduleSearchInput = document.querySelector("#module-search");
const rosterSearchInput = document.querySelector("#roster-search");
const selectAllModules = document.querySelector("#select-all-modules");
const moduleBatchBar = document.querySelector("#module-batch-bar");
const pickerCopySelect = document.querySelector("#picker-copy-from");
const adminList = document.querySelector("#admin-list");
const accessMessage = document.querySelector("#access-message");
const adminMessage = document.querySelector("#admin-message");
const auditMessage = document.querySelector("#audit-message");
const auditRows = document.querySelector("#audit-rows");
const auditSearch = document.querySelector("#audit-search");
const auditAction = document.querySelector("#audit-action");
const auditTableWrap = document.querySelector(".audit-table-wrap");
const pickerDialog = document.querySelector("#people-picker");
const peopleSearch = document.querySelector("#people-search");

const ACTION_LABELS = {
  login: "登录系统",
  logout: "退出系统",
  "passkey.login": "Passkey 登录",
  query: "数据查询",
  "query.detail": "报销明细查询",
  "module_access.update": "修改模块权限",
  "personnel_directory.read": "读取人员目录",
  "ai_analysis.toggle": "切换 AI 分析",
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
  sales_business_analysis: "销售子项目经营分析",
  overdue_receivables: "发票账龄",
  receivable_aging: "应收账龄",
  overdue_risk_combined: "超期风险",
  purchase_orders: "采购订单",
  subproject_purchase_list: "子项目采购清单表",
  expense_claims: "本人费用报销",
  workflow_progress: "审批进度",
};

initialize();

async function initialize() {
  try {
    state.settings = await api("/api/admin/settings");
    document.querySelector("#current-admin").textContent = state.settings.currentAdmin;
    renderAiAnalysisSetting();
    renderAccessSection();
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
    if (category === "query" && !String(event.action || "").startsWith("query")) return false;
    if (category === "admin" && (["login", "logout", "passkey.login"].includes(event.action) || String(event.action || "").startsWith("query"))) return false;
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
  if (String(event.action || "").startsWith("query") && event.outcome === "success") {
    const count = document.createElement("small"); count.textContent = ` ${Number(event.count) || 0} 条 · ${Number(event.durationMs) || 0} ms`; cell.append(count);
  } else if (event.error) {
    const error = document.createElement("small"); error.textContent = ` ${event.error}`; cell.append(error);
  }
  return cell;
}

function auditDetail(event) {
  if (event.action === "ai_analysis.toggle") return `AI 分析已${event.enabled ? "开启" : "关闭"}`;
  if (String(event.action || "").startsWith("query")) {
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
auditTableWrap.addEventListener("wheel", (event) => {
  if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  const maximum = auditTableWrap.scrollHeight - auditTableWrap.clientHeight;
  const reachedTop = event.deltaY < 0 && auditTableWrap.scrollTop <= 0;
  const reachedBottom = event.deltaY > 0 && auditTableWrap.scrollTop >= maximum - 1;
  if (maximum <= 0 || reachedTop || reachedBottom) event.preventDefault();
}, { passive: false });

document.querySelector("#toggle-ai-analysis").addEventListener("click", async () => {
  const button = document.querySelector("#toggle-ai-analysis");
  button.disabled = true;
  document.querySelector("#ai-analysis-message").hidden = true;
  try {
    const enabled = !state.settings.aiAnalysis.enabled;
    const payload = await api("/api/admin/ai-analysis", { method: "PUT", body: JSON.stringify({ enabled }) });
    state.settings.aiAnalysis = { enabled: payload.enabled, configured: payload.configured };
    renderAiAnalysisSetting();
    showMessage(document.querySelector("#ai-analysis-message"), payload.enabled
      ? (payload.configured ? "AI 分析已开启。" : "开关已开启；完成 AI 模型配置后即可使用。")
      : "AI 分析已关闭。", false);
  } catch (error) {
    showMessage(document.querySelector("#ai-analysis-message"), `保存失败：${error.message}`, true);
    button.disabled = false;
  }
});

function renderAiAnalysisSetting() {
  const setting = state.settings?.aiAnalysis;
  const button = document.querySelector("#toggle-ai-analysis");
  if (!setting || !button) return;
  button.disabled = false;
  button.setAttribute("aria-pressed", String(setting.enabled));
  button.textContent = setting.enabled ? "关闭 AI 分析" : "开启 AI 分析";
  document.querySelector("#ai-analysis-status").textContent = setting.enabled
    ? (setting.configured ? "AI 分析已开启，模型配置可用。" : "AI 分析开关已开启，模型配置尚未完成。")
    : "AI 分析已关闭，其他查询不受影响。";
  document.querySelector("#ai-analysis-model").textContent = setting.configured
    ? "AI 模型已配置。关闭后，新的查询不会生成分析上下文。"
    : "尚未检测到完整的 AI 模型配置。开启开关后，补齐模型配置即可使用。";
}

function renderModules() {
  const modules = state.settings?.modules || [];
  const counts = { all: modules.length, open: 0, restricted: 0, uniform_dev: 0, admin_only: 0 };
  for (const module of modules) {
    const isOpen = getModuleMode(module) === "all";
    const isUniformDev = getModuleQueryMode(module) === "dev";
    const names = state.settings.moduleAccess[module.id] || [];
    if (isOpen) counts.open += 1;
    else {
      counts.restricted += 1;
      if (!names.length) counts.admin_only += 1;
    }
    if (isUniformDev) counts.uniform_dev += 1;
  }
  document.querySelector("#tab-modules-count").textContent = String(modules.length);
  document.querySelectorAll(".module-filters [data-count]").forEach((el) => {
    el.textContent = String(counts[el.dataset.count] ?? 0);
  });
  document.querySelectorAll(".module-filters button[data-filter]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.filter === state.moduleFilter));
  });

  const visible = filteredModules();
  const checkedVisibleCount = visible.filter((module) => state.checkedModules.has(module.id)).length;
  selectAllModules.checked = visible.length > 0 && checkedVisibleCount === visible.length;
  selectAllModules.indeterminate = checkedVisibleCount > 0 && checkedVisibleCount < visible.length;
  const includesOpen = modules.some((module) => state.checkedModules.has(module.id) && getModuleMode(module) === "all");
  for (const id of ["batch-set-dev", "batch-add-people"]) {
    const button = document.getElementById(id);
    button.disabled = includesOpen;
    button.title = includesOpen ? "仅适用于指定人员可见的模块" : "";
  }
  moduleBatchBar.hidden = state.checkedModules.size === 0;
  document.querySelector("#batch-count").textContent = `已选 ${state.checkedModules.size} 项`;

  if (!visible.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "module-empty-row";
    cell.textContent = "没有符合条件的模块。";
    row.append(cell);
    moduleRows.replaceChildren(row);
    return;
  }

  moduleRows.replaceChildren(...visible.map((module) => {
    const index = modules.indexOf(module);
    const mode = getModuleMode(module);
    const queryMode = getModuleQueryMode(module);
    const isOpen = mode === "all";
    const isUniformDev = queryMode === "dev";
    const names = state.settings.moduleAccess[module.id] || [];
    const devNames = state.settings.moduleDevAccess[module.id] || [];
    const devKeys = new Set(devNames.map(personKey));

    const row = document.createElement("tr");
    row.dataset.moduleId = module.id;
    if (state.checkedModules.has(module.id)) row.className = "is-checked";

    const checkCell = document.createElement("td");
    checkCell.className = "col-check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.checkedModules.has(module.id);
    checkbox.setAttribute("aria-label", `选择 ${module.label}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.checkedModules.add(module.id);
      else state.checkedModules.delete(module.id);
      renderModules();
    });
    checkCell.append(checkbox);

    const nameCell = document.createElement("td");
    nameCell.className = "col-module";
    const nameWrap = document.createElement("div");
    nameWrap.className = "module-name-cell";
    const num = document.createElement("span");
    num.className = "module-index";
    num.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("strong");
    name.className = "module-name";
    name.textContent = module.label;
    if (module.description) name.title = module.description;
    nameWrap.append(num, name);
    nameCell.append(nameWrap);

    const scopeCell = document.createElement("td");
    scopeCell.className = "col-scope";
    const scopeSwitch = createSegSwitch(`${module.label}访问范围`, [
      { value: "all", label: "全员", attr: "scope", active: isOpen },
      { value: "restricted", label: "指定", attr: "scope", active: !isOpen },
    ], (nextMode, buttons) => updateModuleMode(module, nextMode, buttons));
    scopeCell.append(scopeSwitch);

    const queryCell = document.createElement("td");
    queryCell.className = "col-query";
    if (isOpen) {
      queryCell.textContent = "本人账号";
    } else {
      queryCell.append(createSegSwitch(`${module.label}查询账号`, [
        { value: "self", label: "本人", attr: "query", active: !isUniformDev },
        { value: "dev", label: "统一 dev", attr: "query", active: isUniformDev },
      ], (nextMode, buttons) => updateModuleQueryMode(module, nextMode, buttons)));
    }

    const rosterCell = document.createElement("td");
    rosterCell.className = "col-roster";
    const rosterWrap = document.createElement("div");
    rosterWrap.className = "roster-cell";
    if (isOpen) {
      rosterWrap.append(createPill("全员", "is-muted"));
    } else {
      if (!names.length) {
        rosterWrap.append(createPill("仅超管", "is-muted"));
      } else {
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "roster-trigger";
        trigger.textContent = `${names.length} 人`;
        trigger.addEventListener("click", () => openPeoplePicker(module, "selected"));
        rosterWrap.append(trigger);
        if (isUniformDev) {
          rosterWrap.append(createPill("全 dev", "is-dev"));
        } else if (devNames.length) {
          const devTrigger = document.createElement("button");
          devTrigger.type = "button";
          devTrigger.className = "roster-trigger is-dev";
          devTrigger.textContent = `${devNames.length} dev`;
          devTrigger.addEventListener("click", () => openPeoplePicker(module, "dev"));
          rosterWrap.append(devTrigger);
        }
        rosterWrap.append(createPreview(names, !isUniformDev ? devKeys : null));
      }
    }
    rosterCell.append(rosterWrap);

    const actionCell = document.createElement("td");
    actionCell.className = "col-action";
    if (isOpen) {
      const dash = document.createElement("span");
      dash.className = "row-action-muted";
      dash.textContent = "—";
      actionCell.append(dash);
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "row-action-btn";
      button.textContent = "选人";
      button.addEventListener("click", () => openPeoplePicker(module, "all"));
      actionCell.append(button);
    }

    row.append(checkCell, nameCell, scopeCell, queryCell, rosterCell, actionCell);
    return row;
  }));
}

function createSegSwitch(ariaLabel, options, onSelect) {
  const group = document.createElement("div");
  group.className = "seg-switch";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", ariaLabel);
  const buttons = options.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset[option.attr] = option.value;
    button.setAttribute("aria-pressed", String(option.active));
    button.textContent = option.label;
    group.append(button);
    return button;
  });
  buttons.forEach((button, idx) => {
    button.addEventListener("click", () => onSelect(options[idx].value, buttons));
  });
  return group;
}

function createPill(text, extraClass = "") {
  const pill = document.createElement("span");
  pill.className = `roster-pill ${extraClass}`.trim();
  pill.textContent = text;
  return pill;
}

function createPreview(names, devKeys = null) {
  const span = document.createElement("span");
  span.className = "roster-preview";
  const sample = names.slice(0, 3).map((name) => (devKeys && devKeys.has(personKey(name)) ? `${name}(dev)` : name));
  span.textContent = names.length > 3 ? `${sample.join("、")} 等` : sample.join("、");
  span.title = names.join("、");
  return span;
}

function filteredModules() {
  const keyword = personKey(state.moduleSearch);
  return (state.settings?.modules || []).filter((module) => {
    const isOpen = getModuleMode(module) === "all";
    const isUniformDev = getModuleQueryMode(module) === "dev";
    const names = state.settings.moduleAccess[module.id] || [];
    if (state.moduleFilter === "open" && !isOpen) return false;
    if (state.moduleFilter === "restricted" && isOpen) return false;
    if (state.moduleFilter === "uniform_dev" && !isUniformDev) return false;
    if (state.moduleFilter === "admin_only" && (isOpen || names.length > 0)) return false;
    if (!keyword) return true;
    return personKey(`${module.label} ${module.id} ${module.description || ""}`).includes(keyword);
  });
}

function getModuleMode(module) {
  return state.settings?.moduleAccessModes?.[module.id] || module.defaultAccessMode || "restricted";
}

function getModuleQueryMode(module) {
  return state.settings?.moduleQueryModes?.[module.id] === "dev" ? "dev" : "self";
}

function applyModulePayload(payload) {
  state.settings.moduleAccess = payload.moduleAccess;
  state.settings.moduleDevAccess = payload.moduleDevAccess;
  state.settings.moduleAccessModes = payload.moduleAccessModes;
  state.settings.moduleQueryModes = payload.moduleQueryModes || {};
  renderAccessSection();
}

function renderAccessSection() {
  const isModules = state.moduleView === "modules";
  document.querySelector("#tab-modules").setAttribute("aria-selected", String(isModules));
  document.querySelector("#tab-roster").setAttribute("aria-selected", String(!isModules));
  document.querySelector("#panel-modules").hidden = !isModules;
  document.querySelector("#panel-roster").hidden = isModules;
  renderModules();
  renderRoster();
}

async function updateModuleMode(module, nextMode, buttons) {
  if (getModuleMode(module) === nextMode) return;
  buttons.forEach((button) => { button.disabled = true; });
  accessMessage.hidden = true;
  try {
    const payload = await api("/api/admin/module-access", {
      method: "PUT",
      body: JSON.stringify({ moduleAccessModes: { [module.id]: nextMode } }),
    });
    applyModulePayload(payload);
    showMessage(accessMessage, `${module.label}：已设为${nextMode === "all" ? "全员" : "指定人员"}。`, false);
  } catch (error) {
    showMessage(accessMessage, `保存失败：${error.message}`, true);
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function updateModuleQueryMode(module, nextQueryMode, buttons) {
  if (getModuleQueryMode(module) === nextQueryMode) return;
  buttons.forEach((button) => { button.disabled = true; });
  accessMessage.hidden = true;
  try {
    const payload = await api("/api/admin/module-access", {
      method: "PUT",
      body: JSON.stringify({ moduleQueryModes: { [module.id]: nextQueryMode } }),
    });
    applyModulePayload(payload);
    showMessage(accessMessage, `${module.label}：已设为${nextQueryMode === "dev" ? "统一 dev 查询" : "本人账号查询"}。`, false);
  } catch (error) {
    showMessage(accessMessage, `保存失败：${error.message}`, true);
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function batchUpdateModes({ accessMode = null, queryMode = null }) {
  const ids = [...state.checkedModules];
  if (!ids.length) return;
  accessMessage.hidden = true;
  const body = {};
  if (accessMode) body.moduleAccessModes = Object.fromEntries(ids.map((id) => [id, accessMode]));
  if (queryMode) body.moduleQueryModes = Object.fromEntries(ids.map((id) => [id, queryMode]));
  try {
    const payload = await api("/api/admin/module-access", { method: "PUT", body: JSON.stringify(body) });
    state.checkedModules.clear();
    applyModulePayload(payload);
    const label = accessMode
      ? (accessMode === "all" ? "全员" : "指定人员")
      : (queryMode === "dev" ? "统一 dev" : "本人账号");
    showMessage(accessMessage, `已将 ${ids.length} 个模块设为${label}。`, false);
  } catch (error) {
    showMessage(accessMessage, `批量保存失败：${error.message}`, true);
  }
}

function buildRosterEntries() {
  const byPerson = new Map();
  for (const module of state.settings?.modules || []) {
    const isOpen = getModuleMode(module) === "all";
    const isUniformDev = getModuleQueryMode(module) === "dev";
    const accessList = state.settings.moduleAccess[module.id] || [];
    const devList = state.settings.moduleDevAccess[module.id] || [];
    const devKeys = new Set(devList.map(personKey));
    const addEntry = (name, entry) => {
      const key = personKey(name);
      if (!key) return;
      if (!byPerson.has(key)) byPerson.set(key, { key, name, entries: [] });
      byPerson.get(key).entries.push(entry);
    };
    if (!isOpen) {
      for (const name of accessList) {
        addEntry(name, { module, isOpen: false, isUniformDev, isDev: isUniformDev || devKeys.has(personKey(name)) });
      }
    } else if (!isUniformDev) {
      for (const name of devList) {
        addEntry(name, { module, isOpen: true, isUniformDev: false, isDev: true });
      }
    }
  }
  return [...byPerson.values()].sort((a, b) => b.entries.length - a.entries.length || a.name.localeCompare(b.name, "zh-CN"));
}

function renderRoster() {
  const people = buildRosterEntries();
  const devPeopleCount = people.filter((item) => item.entries.some((entry) => entry.isDev)).length;
  document.querySelector("#tab-roster-count").textContent = String(people.length);
  document.querySelector('[data-roster-count="all"]').textContent = String(people.length);
  document.querySelector('[data-roster-count="dev"]').textContent = String(devPeopleCount);
  document.querySelectorAll(".roster-filters button[data-roster-filter]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.rosterFilter === state.rosterFilter));
  });

  const openModules = (state.settings?.modules || []).filter((module) => getModuleMode(module) === "all");
  const openBar = document.querySelector("#roster-open-modules");
  if (openModules.length) {
    openBar.hidden = false;
    const title = document.createElement("strong");
    title.textContent = "全员开放：";
    const tags = openModules.map((module) => {
      const tag = document.createElement("span");
      tag.className = "roster-open-tag";
      tag.textContent = getModuleQueryMode(module) === "dev" ? `${module.label} · 统一 dev` : module.label;
      return tag;
    });
    openBar.replaceChildren(title, ...tags);
  } else {
    openBar.hidden = true;
  }

  const dirByKey = new Map((state.directory?.people || []).map((person) => [personKey(person.username), person]));
  const deptById = new Map((state.directory?.departments || []).map((dept) => [dept.id, dept]));
  const keyword = personKey(state.rosterSearch);
  const visible = people.filter((item) => {
    if (state.rosterFilter === "dev" && !item.entries.some((entry) => entry.isDev)) return false;
    if (!keyword) return true;
    const dirPerson = dirByKey.get(item.key);
    const depts = dirPerson ? dirPerson.departmentIds.map((id) => deptById.get(id)?.name || "").join(" ") : "";
    const haystack = personKey([item.name, dirPerson?.account || "", depts, ...item.entries.map((entry) => entry.module.label)].join(" "));
    return haystack.includes(keyword);
  });

  if (!visible.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "module-empty-row";
    cell.textContent = people.length ? "没有符合条件的人员。" : "暂无单独授权人员。";
    row.append(cell);
    rosterRows.replaceChildren(row);
    return;
  }

  rosterRows.replaceChildren(...visible.map((item) => {
    const row = document.createElement("tr");
    const personCell = document.createElement("td");
    personCell.className = "col-person roster-person";
    const strong = document.createElement("strong");
    strong.textContent = item.name;
    personCell.append(strong);
    const dirPerson = dirByKey.get(item.key);
    if (dirPerson) {
      const meta = [dirPerson.account, ...dirPerson.departmentIds.map((id) => deptById.get(id)?.name).filter(Boolean)].filter(Boolean).join(" · ");
      if (meta) {
        const small = document.createElement("small");
        small.textContent = meta;
        personCell.append(small);
      }
    }

    const modulesCell = document.createElement("td");
    modulesCell.className = "col-modules";
    const chips = document.createElement("div");
    chips.className = "roster-chips";
    for (const entry of item.entries) {
      const chip = document.createElement("span");
      chip.className = entry.isDev ? "roster-chip is-dev" : "roster-chip";
      const link = document.createElement("button");
      link.type = "button";
      link.className = "roster-chip-link";
      link.textContent = entry.module.label;
      if (entry.isDev) {
        const badge = document.createElement("em");
        badge.textContent = entry.isUniformDev ? "统一dev" : "dev";
        link.append(badge);
      }
      link.addEventListener("click", () => openPeoplePicker(entry.module, "selected"));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "roster-chip-remove";
      remove.title = entry.isOpen ? `取消 ${item.name} 在「${entry.module.label}」的 dev 权限` : `从「${entry.module.label}」移出 ${item.name}`;
      remove.setAttribute("aria-label", remove.title);
      remove.textContent = "×";
      remove.addEventListener("click", () => revokePersonFromModule(item.name, entry.module, entry.isOpen));
      chip.append(link, remove);
      chips.append(chip);
    }
    modulesCell.append(chips);

    const statsCell = document.createElement("td");
    statsCell.className = "col-stats";
    const devCount = item.entries.filter((entry) => entry.isDev).length;
    statsCell.textContent = devCount ? `${item.entries.length} 模块 · ${devCount} dev` : `${item.entries.length} 模块`;

    const actionCell = document.createElement("td");
    actionCell.className = "col-action";
    const removeAll = document.createElement("button");
    removeAll.type = "button";
    removeAll.className = "row-danger-btn";
    removeAll.textContent = "移出全部";
    removeAll.addEventListener("click", () => revokePersonEverywhere(item.name));
    actionCell.append(removeAll);

    row.append(personCell, modulesCell, statsCell, actionCell);
    return row;
  }));
}

async function revokePersonFromModule(name, module, isOpen) {
  const key = personKey(name);
  accessMessage.hidden = true;
  const body = isOpen
    ? {
      moduleDevAccess: {
        [module.id]: (state.settings.moduleDevAccess[module.id] || []).filter((item) => personKey(item) !== key),
      },
    }
    : {
      moduleAccess: {
        [module.id]: (state.settings.moduleAccess[module.id] || []).filter((item) => personKey(item) !== key),
      },
      moduleDevAccess: {
        [module.id]: (state.settings.moduleDevAccess[module.id] || []).filter((item) => personKey(item) !== key),
      },
    };
  try {
    const payload = await api("/api/admin/module-access", { method: "PUT", body: JSON.stringify(body) });
    applyModulePayload(payload);
    showMessage(accessMessage, isOpen ? `已取消 ${name} 在「${module.label}」的 dev 权限。` : `已从「${module.label}」移出 ${name}。`, false);
  } catch (error) {
    showMessage(accessMessage, `操作失败：${error.message}`, true);
  }
}

async function revokePersonEverywhere(name) {
  if (!confirm(`确定将 ${name} 从所有模块的授权和 dev 名单中移除？`)) return;
  const key = personKey(name);
  const moduleAccess = {};
  const moduleDevAccess = {};
  for (const module of state.settings?.modules || []) {
    const access = state.settings.moduleAccess[module.id] || [];
    const dev = state.settings.moduleDevAccess[module.id] || [];
    if (access.some((item) => personKey(item) === key)) {
      moduleAccess[module.id] = access.filter((item) => personKey(item) !== key);
    }
    if (dev.some((item) => personKey(item) === key)) {
      moduleDevAccess[module.id] = dev.filter((item) => personKey(item) !== key);
    }
  }
  accessMessage.hidden = true;
  try {
    const payload = await api("/api/admin/module-access", {
      method: "PUT",
      body: JSON.stringify({ moduleAccess, moduleDevAccess }),
    });
    applyModulePayload(payload);
    showMessage(accessMessage, `已将 ${name} 移出全部授权名单。`, false);
  } catch (error) {
    showMessage(accessMessage, `操作失败：${error.message}`, true);
  }
}

document.querySelector("#tab-modules").addEventListener("click", () => { state.moduleView = "modules"; renderAccessSection(); });
document.querySelector("#tab-roster").addEventListener("click", () => { state.moduleView = "roster"; renderAccessSection(); });
moduleSearchInput.addEventListener("input", () => { state.moduleSearch = moduleSearchInput.value; renderModules(); });
rosterSearchInput.addEventListener("input", () => { state.rosterSearch = rosterSearchInput.value; renderRoster(); });
document.querySelectorAll(".module-filters button[data-filter]").forEach((button) => {
  button.addEventListener("click", () => { state.moduleFilter = button.dataset.filter; renderModules(); });
});
document.querySelectorAll(".roster-filters button[data-roster-filter]").forEach((button) => {
  button.addEventListener("click", () => { state.rosterFilter = button.dataset.rosterFilter; renderRoster(); });
});
selectAllModules.addEventListener("change", () => {
  for (const module of filteredModules()) {
    if (selectAllModules.checked) state.checkedModules.add(module.id);
    else state.checkedModules.delete(module.id);
  }
  renderModules();
});
document.querySelector("#batch-set-all").addEventListener("click", () => batchUpdateModes({ accessMode: "all" }));
document.querySelector("#batch-set-restricted").addEventListener("click", () => batchUpdateModes({ accessMode: "restricted" }));
document.querySelector("#batch-set-self").addEventListener("click", () => batchUpdateModes({ queryMode: "self" }));
document.querySelector("#batch-set-dev").addEventListener("click", () => batchUpdateModes({ queryMode: "dev" }));
document.querySelector("#batch-clear").addEventListener("click", () => { state.checkedModules.clear(); renderModules(); });
document.querySelector("#batch-add-people").addEventListener("click", () => {
  const modules = (state.settings?.modules || []).filter((module) => state.checkedModules.has(module.id));
  if (modules.length) openBatchPeoplePicker(modules);
});

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

async function openPeoplePicker(module, initialScope = "all") {
  if (getModuleMode(module) === "all") return;
  accessMessage.hidden = true;
  const mode = getModuleMode(module);
  const queryMode = getModuleQueryMode(module);
  const selected = new Map((state.settings.moduleAccess[module.id] || []).map((name) => [personKey(name), name]));
  const dev = new Map((state.settings.moduleDevAccess[module.id] || []).map((name) => [personKey(name), name]));
  state.picker = {
    batch: false,
    module,
    modules: [module],
    mode,
    queryMode,
    scope: initialScope,
    selected,
    dev,
  };
  peopleSearch.value = "";
  const isOpen = mode === "all";
  const isUniformDev = queryMode === "dev";
  document.querySelector("#people-picker-title").textContent = module.label;
  renderPickerTags([
    { text: isOpen ? "全员开放" : "指定人员", cls: isOpen ? "is-open" : "is-restricted" },
    { text: isUniformDev ? "统一 dev" : (isOpen ? "勾选即 dev" : "默认本人 · 可设 dev"), cls: isUniformDev ? "is-dev" : "" },
  ]);
  populateCopySelect(module);
  document.querySelector("#clear-selection").textContent = isOpen ? "清空 dev" : "清空名单";
  document.querySelector("#save-module-access").textContent = "保存";
  await launchPickerDialog();
}

async function openBatchPeoplePicker(modules) {
  if (modules.some((module) => getModuleMode(module) === "all")) return;
  accessMessage.hidden = true;
  state.picker = {
    batch: true,
    module: null,
    modules,
    mode: "restricted",
    queryMode: "self",
    scope: "all",
    selected: new Map(),
    dev: new Map(),
  };
  peopleSearch.value = "";
  document.querySelector("#people-picker-title").textContent = `批量添加 · ${modules.length} 个模块`;
  renderPickerTags([
    { text: "仅追加，保留原名单", cls: "is-open" },
    { text: "可同时指定 dev", cls: "" },
  ]);
  pickerCopySelect.hidden = true;
  document.querySelector("#clear-selection").textContent = "清空已选";
  document.querySelector("#save-module-access").textContent = `添加到 ${modules.length} 个模块`;
  await launchPickerDialog();
}

function renderPickerTags(tags) {
  const container = document.querySelector("#picker-tags");
  container.replaceChildren(...tags.map((item) => {
    const span = document.createElement("span");
    span.className = `picker-tag ${item.cls || ""}`.trim();
    span.textContent = item.text;
    return span;
  }));
}

function populateCopySelect(currentModule) {
  const isOpen = getModuleMode(currentModule) === "all";
  const candidates = (state.settings?.modules || []).filter((other) => {
    if (other.id === currentModule.id) return false;
    const count = isOpen
      ? (state.settings.moduleDevAccess[other.id] || []).length || (state.settings.moduleAccess[other.id] || []).length
      : (state.settings.moduleAccess[other.id] || []).length;
    return count > 0;
  });
  pickerCopySelect.hidden = candidates.length === 0;
  pickerCopySelect.replaceChildren(
    new Option("从其他模块复制…", ""),
    ...candidates.map((other) => {
      const accessCount = (state.settings.moduleAccess[other.id] || []).length;
      const devCount = (state.settings.moduleDevAccess[other.id] || []).length;
      const countText = isOpen && devCount ? `${devCount} dev` : `${accessCount || devCount} 人`;
      return new Option(`${other.label} (${countText})`, other.id);
    }),
  );
  pickerCopySelect.value = "";
}

async function launchPickerDialog() {
  const token = state.picker;
  document.querySelector("#picker-message").textContent = state.directory ? "" : "正在读取组织架构…";
  pickerDialog.showModal();
  try {
    if (!state.directory) state.directory = await api("/api/admin/personnel-directory");
    if (state.picker !== token || !pickerDialog.open) return;
    renderOrganizationTree();
    renderPeopleList();
    if (state.moduleView === "roster") renderRoster();
  } catch (error) {
    document.querySelector("#picker-message").textContent = `读取人员失败：${error.message}`;
  }
}

function personKey(value) { return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN"); }

function activePickerSelection() {
  if (!state.picker) return new Map();
  return state.picker.mode === "all" && !state.picker.batch ? state.picker.dev : state.picker.selected;
}

function missingSelectedPeople(map) {
  if (!state.directory) return [];
  const known = new Set(state.directory.people.map((person) => personKey(person.username)));
  return [...map.values()]
    .filter((name) => !known.has(personKey(name)))
    .map((username) => ({ username, account: "", departmentIds: [], missing: true }));
}

function scopePeople() {
  if (!state.directory || !state.picker) return [];
  const scope = state.picker.scope;
  if (scope === "selected") {
    const active = activePickerSelection();
    const matched = state.directory.people.filter((person) => active.has(personKey(person.username)));
    return [...matched, ...missingSelectedPeople(active)];
  }
  if (scope === "dev") {
    const matched = state.directory.people.filter((person) => state.picker.dev.has(personKey(person.username)));
    return [...matched, ...missingSelectedPeople(state.picker.dev)];
  }
  if (scope === "all") return state.directory.people;
  if (scope === "unassigned") return state.directory.people.filter((person) => !person.departmentIds.length);
  if (scope.startsWith("org:")) {
    const ids = new Set(state.directory.departments.filter((dept) => dept.organizationId === scope.slice(4)).map((dept) => dept.id));
    return state.directory.people.filter((person) => person.departmentIds.some((id) => ids.has(id)));
  }
  const ids = new Set([scope.slice(5)]);
  for (let previous = -1; previous !== ids.size;) {
    previous = ids.size;
    state.directory.departments.forEach((dept) => { if (ids.has(dept.parentId)) ids.add(dept.id); });
  }
  return state.directory.people.filter((person) => person.departmentIds.some((id) => ids.has(id)));
}

function renderOrganizationTree() {
  const tree = document.querySelector("#org-tree");
  if (!state.directory || !state.picker) { tree.textContent = "读取中…"; return; }
  const nodes = [];
  const addNode = (scope, title, depth, count, pinned = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = pinned ? "org-node is-pinned" : "org-node";
    button.style.paddingLeft = `${12 + depth * 16}px`;
    button.setAttribute("aria-current", String(state.picker.scope === scope));
    const label = document.createElement("span"); label.textContent = title;
    const number = document.createElement("small"); number.textContent = count;
    button.append(label, number);
    button.addEventListener("click", () => { state.picker.scope = scope; renderOrganizationTree(); renderPeopleList(); });
    nodes.push(button);
  };
  const isOpen = state.picker.mode === "all" && !state.picker.batch;
  const isUniformDev = state.picker.queryMode === "dev" && !state.picker.batch;
  const active = activePickerSelection();
  addNode("selected", state.picker.batch ? "本次已选" : (isOpen ? "已设 dev" : "已授权名单"), 0, active.size, true);
  if (!isOpen && !isUniformDev && state.picker.dev.size > 0) {
    addNode("dev", "其中 dev", 0, state.picker.dev.size, true);
  }
  const divider = document.createElement("div");
  divider.className = "org-divider";
  nodes.push(divider);
  addNode("all", "全部人员", 0, state.directory.people.length);
  const children = (orgId, parentId, depth, seen = new Set()) => {
    state.directory.departments.filter((dept) => dept.organizationId === orgId && dept.parentId === parentId && !seen.has(dept.id)).forEach((dept) => {
      addNode(`dept:${dept.id}`, dept.name, depth, state.directory.people.filter((person) => person.departmentIds.includes(dept.id)).length);
      children(orgId, dept.id, depth + 1, new Set([...seen, dept.id]));
    });
  };
  state.directory.organizations.forEach((org) => {
    addNode(`org:${org.id}`, org.name, 0, state.directory.people.filter((person) => person.departmentIds.some((id) => state.directory.departments.some((dept) => dept.id === id && dept.organizationId === org.id))).length);
    children(org.id, "", 1);
  });
  if (state.directory.unassignedCount) addNode("unassigned", "未归属部门", 0, state.directory.unassignedCount);
  tree.replaceChildren(...nodes);
}

function visiblePeople() {
  const keyword = personKey(peopleSearch.value);
  const departmentById = new Map(state.directory.departments.map((dept) => [dept.id, dept]));
  return scopePeople().filter((person) => !keyword || personKey([person.username, person.account, ...person.departmentIds.map((id) => departmentById.get(id)?.fullName || departmentById.get(id)?.name)].join(" ")).includes(keyword));
}

function renderPeopleList() {
  if (!state.directory || !state.picker) return;
  const people = visiblePeople();
  const scope = state.picker.scope;
  const isOpen = state.picker.mode === "all" && !state.picker.batch;
  const isUniformDev = state.picker.queryMode === "dev" && !state.picker.batch;
  const showPerPersonDev = !isOpen && !isUniformDev;

  document.querySelector("#bulk-set-dev").hidden = !showPerPersonDev;
  document.querySelector("#bulk-set-self").hidden = !showPerPersonDev;
  document.querySelector("#picker-scope-title").textContent = scope === "selected"
    ? (state.picker.batch ? "本次已选" : (isOpen ? "已设 dev" : "已授权名单"))
    : scope === "dev"
      ? "其中 dev"
      : scope === "all"
        ? "全部人员"
        : scope === "unassigned"
          ? "未归属部门"
          : scope.startsWith("org:")
            ? state.directory.organizations.find((org) => org.id === scope.slice(4))?.name || "组织"
            : state.directory.departments.find((dept) => dept.id === scope.slice(5))?.name || "部门";
  document.querySelector("#picker-results-count").textContent = `${people.length} 人`;
  const updateSelectedCount = () => {
    document.querySelector("#picker-selected-count").textContent = isOpen
      ? `已设 dev ${state.picker.dev.size} 人`
      : isUniformDev
        ? `已选 ${state.picker.selected.size} 人（统一 dev）`
        : state.picker.dev.size
          ? `已选 ${state.picker.selected.size} 人 · ${state.picker.dev.size} 人 dev`
          : `已选 ${state.picker.selected.size} 人`;
    renderOrganizationTree();
  };
  document.querySelector("#picker-selected-count").textContent = isOpen
    ? `已设 dev ${state.picker.dev.size} 人`
    : isUniformDev
      ? `已选 ${state.picker.selected.size} 人（统一 dev）`
      : state.picker.dev.size
        ? `已选 ${state.picker.selected.size} 人 · ${state.picker.dev.size} 人 dev`
        : `已选 ${state.picker.selected.size} 人`;

  const departmentById = new Map(state.directory.departments.map((dept) => [dept.id, dept]));
  const rows = people.map((person) => {
    const row = document.createElement("div"); row.className = "person-row";
    const label = document.createElement("label"); label.className = "person-choice";
    const key = personKey(person.username);
    const isChecked = isOpen ? state.picker.dev.has(key) : state.picker.selected.has(key);
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = isChecked;

    const body = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = person.username;
    if (person.missing) {
      const miss = document.createElement("span");
      miss.className = "person-missing-tag";
      miss.textContent = "不在当前目录";
      name.append(miss);
    }
    const detail = document.createElement("small");
    detail.textContent = person.missing
      ? "原有配置账号 · 取消勾选即可移除"
      : [person.account, ...person.departmentIds.map((id) => departmentById.get(id)?.fullName || departmentById.get(id)?.name).filter(Boolean)].join(" · ") || "未归属部门";
    body.append(name, detail);
    label.append(check, body);
    row.append(label);

    let identitySwitch = null;
    let devBadge = null;
    if (showPerPersonDev) {
      identitySwitch = document.createElement("div");
      identitySwitch.className = "person-identity-switch";
      const selfBtn = document.createElement("button");
      selfBtn.type = "button";
      selfBtn.dataset.idMode = "self";
      selfBtn.textContent = "本人";
      const devBtn = document.createElement("button");
      devBtn.type = "button";
      devBtn.dataset.idMode = "dev";
      devBtn.textContent = "dev";
      const syncIdentityButtons = () => {
        const active = state.picker.selected.has(key);
        const isDev = active && state.picker.dev.has(key);
        selfBtn.setAttribute("aria-pressed", String(active && !isDev));
        devBtn.setAttribute("aria-pressed", String(isDev));
      };
      syncIdentityButtons();
      selfBtn.addEventListener("click", () => {
        state.picker.selected.set(key, person.username);
        state.picker.dev.delete(key);
        check.checked = true;
        syncIdentityButtons();
        updateSelectedCount();
      });
      devBtn.addEventListener("click", () => {
        state.picker.selected.set(key, person.username);
        state.picker.dev.set(key, person.username);
        check.checked = true;
        syncIdentityButtons();
        updateSelectedCount();
      });
      identitySwitch.append(selfBtn, devBtn);
      identitySwitch._sync = syncIdentityButtons;
      row.append(identitySwitch);
    } else if (isChecked) {
      devBadge = document.createElement("span");
      devBadge.className = "person-identity-badge";
      devBadge.textContent = "dev";
      row.append(devBadge);
    }

    check.addEventListener("change", () => {
      if (isOpen) {
        if (check.checked) state.picker.dev.set(key, person.username);
        else state.picker.dev.delete(key);
      } else {
        if (check.checked) state.picker.selected.set(key, person.username);
        else {
          state.picker.selected.delete(key);
          state.picker.dev.delete(key);
        }
      }
      if (identitySwitch) identitySwitch._sync();
      else renderPeopleList();
      updateSelectedCount();
    });
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "picker-empty";
    empty.textContent = scope === "selected" ? "暂未选择人员。" : "当前范围没有符合条件的人员。";
    rows.push(empty);
  }
  document.querySelector("#people-list").replaceChildren(...rows);
  const missing = missingSelectedPeople(activePickerSelection());
  document.querySelector("#picker-message").textContent = missing.length
    ? `${missing.length} 个账号不在当前目录，可在“${isOpen ? "已设 dev" : "已授权名单"}”中单独移除。`
    : state.directory.ambiguousUsers ? `${state.directory.ambiguousUsers} 个重名账号已排除。` : "";
}

peopleSearch.addEventListener("input", renderPeopleList);
pickerCopySelect.addEventListener("change", () => {
  const sourceId = pickerCopySelect.value;
  if (!sourceId || !state.picker || state.picker.batch) return;
  const isOpen = state.picker.mode === "all";
  const sourceAccess = state.settings.moduleAccess[sourceId] || [];
  const sourceDev = state.settings.moduleDevAccess[sourceId] || [];
  if (isOpen) {
    const list = sourceDev.length ? sourceDev : sourceAccess;
    state.picker.dev = new Map(list.map((name) => [personKey(name), name]));
  } else {
    state.picker.selected = new Map(sourceAccess.map((name) => [personKey(name), name]));
    const allowed = new Set(sourceAccess.map(personKey));
    state.picker.dev = new Map(sourceDev.filter((name) => allowed.has(personKey(name))).map((name) => [personKey(name), name]));
  }
  state.picker.scope = "selected";
  pickerCopySelect.value = "";
  renderOrganizationTree();
  renderPeopleList();
});
document.querySelector("#close-people-picker").addEventListener("click", () => pickerDialog.close());
pickerDialog.addEventListener("close", () => { state.picker = null; });
document.querySelector("#refresh-directory").addEventListener("click", async (event) => {
  const button = event.currentTarget; button.disabled = true;
  try { state.directory = await api("/api/admin/personnel-directory?refresh=1"); renderOrganizationTree(); renderPeopleList(); }
  catch (error) { document.querySelector("#picker-message").textContent = `刷新失败：${error.message}`; }
  finally { button.disabled = false; }
});
for (const [id, selected] of [["select-visible", true], ["deselect-visible", false]]) {
  document.querySelector(`#${id}`).addEventListener("click", () => {
    if (!state.directory || !state.picker) return;
    const isOpen = state.picker.mode === "all" && !state.picker.batch;
    for (const person of visiblePeople()) {
      const key = personKey(person.username);
      if (isOpen) {
        if (selected) state.picker.dev.set(key, person.username);
        else state.picker.dev.delete(key);
      } else if (selected) {
        state.picker.selected.set(key, person.username);
      } else {
        state.picker.selected.delete(key);
        state.picker.dev.delete(key);
      }
    }
    renderOrganizationTree();
    renderPeopleList();
  });
}
for (const [id, asDev] of [["bulk-set-dev", true], ["bulk-set-self", false]]) {
  document.querySelector(`#${id}`).addEventListener("click", () => {
    if (!state.directory || !state.picker) return;
    for (const person of visiblePeople()) {
      const key = personKey(person.username);
      if (asDev) {
        state.picker.selected.set(key, person.username);
        state.picker.dev.set(key, person.username);
      } else if (state.picker.selected.has(key)) {
        state.picker.dev.delete(key);
      }
    }
    renderOrganizationTree();
    renderPeopleList();
  });
}
document.querySelector("#clear-selection").addEventListener("click", () => {
  if (!state.picker) return;
  if (state.picker.mode === "all" && !state.picker.batch) state.picker.dev.clear();
  else {
    state.picker.selected.clear();
    state.picker.dev.clear();
  }
  renderOrganizationTree();
  renderPeopleList();
});
document.querySelector("#save-module-access").addEventListener("click", async (event) => {
  if (!state.picker || !state.directory) return;
  const button = event.currentTarget;
  if (state.picker.batch) {
    if (!state.picker.selected.size) {
      document.querySelector("#picker-message").textContent = "请至少选择 1 名人员。";
      return;
    }
    const moduleAccess = {};
    const moduleDevAccess = {};
    const pickedNames = [...state.picker.selected.values()];
    const pickedDev = pickedNames.filter((name) => state.picker.dev.has(personKey(name)));
    for (const module of state.picker.modules) {
      const isOpen = getModuleMode(module) === "all";
      const existingAccess = state.settings.moduleAccess[module.id] || [];
      const existingDev = state.settings.moduleDevAccess[module.id] || [];
      if (!isOpen) {
        const mergedAccess = new Map(existingAccess.map((name) => [personKey(name), name]));
        for (const name of pickedNames) mergedAccess.set(personKey(name), name);
        if (mergedAccess.size > 200) {
          document.querySelector("#picker-message").textContent = `「${module.label}」合并后超过 200 人上限。`;
          return;
        }
        moduleAccess[module.id] = [...mergedAccess.values()];
      }
      if (pickedDev.length) {
        const mergedDev = new Map(existingDev.map((name) => [personKey(name), name]));
        for (const name of pickedDev) mergedDev.set(personKey(name), name);
        if (mergedDev.size > 200) {
          document.querySelector("#picker-message").textContent = `「${module.label}」dev 名单超过 200 人上限。`;
          return;
        }
        moduleDevAccess[module.id] = [...mergedDev.values()];
      }
    }
    if (!Object.keys(moduleAccess).length && !Object.keys(moduleDevAccess).length) {
      document.querySelector("#picker-message").textContent = "所选模块均为全员开放，请将人员切换为 dev 后再添加。";
      return;
    }
    button.disabled = true;
    try {
      const payload = await api("/api/admin/module-access", { method: "PUT", body: JSON.stringify({ moduleAccess, moduleDevAccess }) });
      const count = state.picker.modules.length;
      state.checkedModules.clear();
      applyModulePayload(payload);
      pickerDialog.close();
      showMessage(accessMessage, `已将 ${pickedNames.length} 人添加到 ${count} 个模块。`, false);
    } catch (error) {
      document.querySelector("#picker-message").textContent = `保存失败：${error.message}`;
    } finally {
      button.disabled = false;
    }
    return;
  }
  const isOpen = state.picker.mode === "all";
  if ((isOpen ? state.picker.dev.size : state.picker.selected.size) > 200) {
    document.querySelector("#picker-message").textContent = "每个模块最多可选择 200 人。";
    return;
  }
  button.disabled = true;
  const module = state.picker.module;
  try {
    const selected = [...state.picker.selected.values()];
    const body = {
      moduleAccess: { [module.id]: selected },
      moduleDevAccess: { [module.id]: selected.filter((name) => state.picker.dev.has(personKey(name))) },
    };
    const payload = await api("/api/admin/module-access", { method: "PUT", body: JSON.stringify(body) });
    applyModulePayload(payload);
    pickerDialog.close();
    showMessage(accessMessage, `${module.label}：权限名单已保存。`, false);
  } catch (error) { document.querySelector("#picker-message").textContent = `保存失败：${error.message}`; }
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

function showMessage(element, message, isError) {
  element.textContent = message; element.classList.toggle("error", isError); element.hidden = false;
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.message || `请求失败 (${response.status})`), { status: response.status });
  return payload;
}
