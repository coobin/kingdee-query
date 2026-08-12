const state = { lastResult: null };
const els = {
  session: document.querySelector("#session"), sessionLabel: document.querySelector("#session-label"),
  service: document.querySelector("#service-status"), toolList: document.querySelector("#tool-list"),
  input: document.querySelector("#query-input"), button: document.querySelector("#query-button"),
  panel: document.querySelector("#result-panel"), tool: document.querySelector("#result-tool"),
  summary: document.querySelector("#result-summary"), plan: document.querySelector("#plan-strip"),
  table: document.querySelector("#table-wrap"), export: document.querySelector("#export-button"),
};

initialize();

async function initialize() {
  try {
    const [session, catalog] = await Promise.all([api("/api/session"), api("/api/catalog")]);
    els.session.classList.add("ready");
    els.sessionLabel.textContent = `${session.user.name || session.user.userId} · ${session.user.kingdeeUsername}`;
    els.service.textContent = "READY";
    renderTools(catalog.tools);
  } catch (error) {
    els.session.classList.add("error");
    els.sessionLabel.textContent = "需要通过 SSO 登录";
    els.service.textContent = "AUTH REQUIRED";
    els.toolList.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
    els.button.disabled = true;
  }
}

els.button.addEventListener("click", runQuery);
els.input.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") runQuery();
});
document.querySelectorAll("[data-query]").forEach((button) => button.addEventListener("click", () => {
  els.input.value = button.dataset.query;
  els.input.focus();
}));
els.export.addEventListener("click", exportCsv);

async function runQuery() {
  const question = els.input.value.trim();
  if (!question) { els.input.focus(); return; }
  setLoading(true);
  els.panel.hidden = false;
  els.tool.textContent = "QUERY IN PROGRESS";
  els.summary.textContent = "正在向金蝶读取数据…";
  els.plan.textContent = "";
  els.table.innerHTML = "";
  els.panel.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const payload = await api("/api/query", { method: "POST", body: JSON.stringify({ question }) });
    state.lastResult = payload.result;
    renderResult(payload);
  } catch (error) {
    els.tool.textContent = "QUERY STOPPED";
    els.summary.textContent = "这次查询没有完成";
    els.table.innerHTML = `<div class="error-box">${escapeHtml(error.message)}${error.requestId ? `<br><small>请求编号：${escapeHtml(error.requestId)}</small>` : ""}</div>`;
    els.export.hidden = true;
  } finally { setLoading(false); }
}

function renderTools(tools) {
  els.toolList.replaceChildren(...tools.map((tool, index) => {
    const item = document.createElement("div"); item.className = "tool";
    item.innerHTML = `<span class="tool-index">${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(tool.label)}</strong><p>${escapeHtml(tool.description)}</p></div><span class="tool-state ${tool.available === false ? "off" : ""}" title="${tool.available === false ? "待配置" : "可用"}"></span>`;
    return item;
  }));
}

function renderResult(payload) {
  const { result, plan } = payload;
  els.tool.textContent = `${result.label || plan.tool} · ${String(result.count ?? 0).padStart(2, "0")} ROWS`;
  els.summary.textContent = result.summary || "查询完成";
  els.plan.replaceChildren(...Object.entries(plan.arguments || {}).filter(([, value]) => value !== "" && value != null).map(([key, value]) => {
    const tag = document.createElement("span"); tag.textContent = `${key}: ${value}`; return tag;
  }));
  if (result.workflow) {
    const pre = document.createElement("pre"); pre.textContent = JSON.stringify(result.workflow, null, 2); els.table.replaceChildren(pre); els.export.hidden = true; return;
  }
  if (result.aggregate) {
    const card = document.createElement("div");
    card.className = "aggregate-card";
    card.innerHTML = `<span>${escapeHtml(result.aggregate.label)}</span><strong>${formatMoney(result.aggregate.value)}</strong><small>${result.aggregate.records} 笔记录${result.aggregate.partial ? " · 汇总达到上限" : " · 已完整汇总"}</small>`;
    els.table.append(card);
  }
  if (!result.rows?.length) {
    if (!result.aggregate) els.table.replaceChildren(document.querySelector("#empty-template").content.cloneNode(true));
    els.export.hidden = true; return;
  }
  const table = document.createElement("table");
  const thead = document.createElement("thead"); const headRow = document.createElement("tr");
  result.columns.forEach((column) => { const th = document.createElement("th"); th.scope = "col"; th.textContent = column; headRow.append(th); });
  thead.append(headRow); table.append(thead);
  const tbody = document.createElement("tbody");
  result.rows.forEach((row) => { const tr = document.createElement("tr"); result.columns.forEach((column) => { const td = document.createElement("td"); td.textContent = formatValue(row[column]); tr.append(td); }); tbody.append(tr); });
  table.append(tbody); els.table.append(table); els.export.hidden = false;
}

function setLoading(loading) {
  els.button.disabled = loading;
  els.button.querySelector("span").textContent = loading ? "正在查询" : "开始查询";
}
function formatValue(value) { if (value == null || value === "") return "—"; if (typeof value === "object") return JSON.stringify(value); return String(value); }
function formatMoney(value) { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(Number(value) || 0); }
async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.message || `请求失败 (${response.status})`), payload);
  return payload;
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function exportCsv() {
  const result = state.lastResult; if (!result?.rows?.length) return;
  const cells = (values) => values.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",");
  const csv = "\ufeff" + [cells(result.columns), ...result.rows.map((row) => cells(result.columns.map((column) => row[column])))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `${result.label || "kingdee-query"}-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
}
