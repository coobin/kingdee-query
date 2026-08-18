const TOOL_META = {
  inventory: { action: "查询即时库存", conditionLabels: { materialNumber: "物料编码" } },
  inventory_cycle: { action: "查询库存周期", conditionLabels: { materialNumber: "物料编码", materialName: "物料名称", subprojectNumber: "销售子项目编码", warehouseName: "仓库名称", warehouseScope: "查看范围", minimumDays: "最少库存周期" } },
  sales_orders: { action: "查询销售订单", conditionLabels: { billNumber: "单据编号", customerName: "客户名称", dateFrom: "开始日期", dateTo: "结束日期" } },
  overdue_receivables: { action: "统计发票账龄", conditionLabels: { minimumDays: "超过天数", customerName: "客户名称", subprojectNumber: "销售子项目编码" } },
  receivable_aging: { action: "统计应收账龄", conditionLabels: { minimumDays: "超过天数", customerName: "客户名称", subprojectNumber: "销售子项目编码" } },
  overdue_risk_combined: { action: "统计合并风险", conditionLabels: { invoiceDays: "发票超期天数", receivableDays: "应收超期天数", customerName: "客户名称", subprojectNumber: "销售子项目编码" } },
  purchase_orders: { action: "查询采购订单", conditionLabels: { billNumber: "单据编号", supplierName: "供应商名称", dateFrom: "开始日期", dateTo: "结束日期" } },
  expense_claims: { action: "查询我的报销", conditionLabels: { dateFrom: "开始日期", dateTo: "结束日期", aggregation: "金额汇总" } },
};
const state = { selectedTool: readSelectedTool(), lastResult: null, tableRows: [], tableSort: { column: "", direction: 1 }, tools: [], accessibleTools: new Set() };
const els = {
  session: document.querySelector("#session"), sessionLabel: document.querySelector("#session-label"), service: document.querySelector("#service-status"),
  toolList: document.querySelector("#tool-list"), form: document.querySelector("#query-form"), button: document.querySelector("#query-button"), formError: document.querySelector("#form-error"),
  tabs: [...document.querySelectorAll("[data-tool]")], panels: [...document.querySelectorAll("[data-panel]")], panel: document.querySelector("#result-panel"),
  tool: document.querySelector("#result-tool"), summary: document.querySelector("#result-summary"), plan: document.querySelector("#plan-strip"),
  table: document.querySelector("#table-wrap"), export: document.querySelector("#export-button"),
};

initialize();

async function initialize() {
  setDefaultDates();
  selectTool(state.selectedTool, false);
  try {
    const [session, catalog] = await Promise.all([api("/api/session"), api("/api/catalog")]);
    els.session.classList.add("ready");
    els.sessionLabel.textContent = `${session.user.name || session.user.userId} · ${session.user.kingdeeUsername}`;
    document.querySelector("#admin-link").hidden = !session.user.isSuperAdmin;
    els.service.textContent = "READY";
    state.tools = catalog.tools;
    applyCatalogAccess(catalog.tools);
    renderTools(catalog.tools);
  } catch (error) {
    els.session.classList.add("error");
    els.sessionLabel.textContent = "需要通过 SSO 登录";
    els.service.textContent = "AUTH REQUIRED";
    els.toolList.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`;
    els.button.disabled = true;
  }
}

els.tabs.forEach((tab) => tab.addEventListener("click", () => selectTool(tab.dataset.tool)));
els.tabs.forEach((tab) => tab.addEventListener("keydown", (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const visibleTabs = els.tabs.filter((item) => !item.hidden);
  const next = (visibleTabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length;
  visibleTabs[next]?.focus(); visibleTabs[next]?.click();
}));
document.querySelectorAll('[data-aging-threshold-input]').forEach((input) => {
  input.addEventListener("input", () => {
    const value = Number(input.value);
    const badge = document.querySelector(`[data-aging-threshold-badge="${input.dataset.agingThresholdInput}"]`);
    if (badge) badge.textContent = Number.isInteger(value) && value > 0 ? `${value + 1}+` : "AGE";
  });
});
els.form.addEventListener("submit", runQuery);
els.export.addEventListener("click", exportCsv);

function selectTool(tool, focus = true) {
  if (!TOOL_META[tool]) return;
  if (state.accessibleTools.size && !state.accessibleTools.has(tool)) return;
  state.selectedTool = tool;
  persistSelectedTool(tool);
  els.tabs.forEach((tab) => { const active = tab.dataset.tool === tool; tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1; });
  els.panels.forEach((panel) => { panel.hidden = panel.dataset.panel !== tool; });
  els.button.querySelector("span").textContent = TOOL_META[tool].action;
  els.formError.hidden = true;
  document.querySelectorAll(".tool[data-tool-id]").forEach((item) => item.classList.toggle("active", item.dataset.toolId === tool));
  if (focus) els.panels.find((panel) => panel.dataset.panel === tool)?.querySelector("input")?.focus();
}

function readSelectedTool() {
  try {
    const saved = globalThis.localStorage?.getItem("kingdee-query-hub.selected-tool");
    return TOOL_META[saved] ? saved : "inventory";
  } catch {
    return "inventory";
  }
}

function persistSelectedTool(tool) {
  try { globalThis.localStorage?.setItem("kingdee-query-hub.selected-tool", tool); } catch { /* storage may be disabled */ }
}

function applyCatalogAccess(tools) {
  state.accessibleTools = new Set(tools.filter((tool) => TOOL_META[tool.id]).map((tool) => tool.id));
  els.tabs.forEach((tab) => { tab.hidden = !state.accessibleTools.has(tab.dataset.tool); });
  const firstAccessible = Object.keys(TOOL_META).find((id) => state.accessibleTools.has(id));
  if (firstAccessible && !state.accessibleTools.has(state.selectedTool)) selectTool(firstAccessible, false);
  if (!firstAccessible) {
    els.panels.forEach((panel) => { panel.hidden = true; });
    els.button.disabled = true;
    showFormError("当前账号还没有配置任何查询模块，请联系超级管理员。");
  }
}

async function runQuery(event) {
  event.preventDefault();
  const activePanel = els.panels.find((panel) => panel.dataset.panel === state.selectedTool);
  const invalid = activePanel.querySelector(":invalid");
  if (invalid) { invalid.focus(); showFormError("请先填写所有必填条件。"); return; }
  const arguments_ = collectArguments(activePanel);
  const error = validateArguments(state.selectedTool, arguments_);
  if (error) { showFormError(error); return; }
  els.formError.hidden = true;
  setLoading(true);
  els.panel.hidden = false;
  els.tool.textContent = "QUERY IN PROGRESS";
  els.summary.textContent = "正在向金蝶读取数据…";
  els.plan.textContent = "";
  els.table.innerHTML = "";
  els.panel.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const question = `${TOOL_META[state.selectedTool].action}（结构化表单）`;
    const payload = await api("/api/query", { method: "POST", body: JSON.stringify({ tool: state.selectedTool, arguments: arguments_, question }) });
    state.lastResult = payload.result;
    renderResult(payload);
  } catch (error_) {
    els.tool.textContent = "QUERY STOPPED";
    els.summary.textContent = "这次查询没有完成";
    els.table.innerHTML = `<div class="error-box">${escapeHtml(error_.message)}${error_.requestId ? `<br><small>请求编号：${escapeHtml(error_.requestId)}</small>` : ""}</div>`;
    els.export.hidden = true;
  } finally { setLoading(false); }
}

function collectArguments(panel) {
  const args = { limit: 100 };
  panel.querySelectorAll("input[name]").forEach((input) => {
    if (input.type === "checkbox") { if (input.checked) args[input.name] = input.value; return; }
    const value = input.value.trim(); if (value) args[input.name] = value;
  });
  return args;
}

function validateArguments(tool, args) {
  if (args.dateFrom && args.dateTo && args.dateFrom > args.dateTo) return "开始日期不能晚于结束日期。";
  if (tool === "inventory" && !args.materialNumber) return "请输入完整物料编码。";
  if (tool === "inventory_cycle" && !args.materialNumber && !args.materialName && !args.subprojectNumber && !args.warehouseName && args.warehouseScope === "all") return "请至少填写物料、销售子项目或仓库条件中的一项，不能只填写最少库存周期。";
  if (tool === "inventory_cycle" && (!Number.isInteger(Number(args.minimumDays)) || Number(args.minimumDays) < 0 || Number(args.minimumDays) > 3650)) return "最少库存周期应为 0 到 3650 之间的整数。";
  if (tool === "sales_orders" && !args.billNumber && !args.customerName && !args.dateFrom && !args.dateTo) return "请至少填写单据编号、客户名称或日期范围中的一项。";
  if (["overdue_receivables", "receivable_aging"].includes(tool) && (!Number.isInteger(Number(args.minimumDays)) || Number(args.minimumDays) < 1 || Number(args.minimumDays) > 3650)) return "超过天数应为 1 到 3650 之间的整数。";
  if (tool === "overdue_risk_combined" && (!["invoiceDays", "receivableDays"].every((key) => Number.isInteger(Number(args[key])) && Number(args[key]) >= 1 && Number(args[key]) <= 3650))) return "发票和应收超期天数都应为 1 到 3650 之间的整数。";
  if (tool === "purchase_orders" && !args.billNumber && !args.supplierName && !args.dateFrom && !args.dateTo) return "请至少填写单据编号、供应商名称或日期范围中的一项。";
  return "";
}

function showFormError(message) { els.formError.textContent = message; els.formError.hidden = false; }

function setDefaultDates() {
  const today = new Date();
  const end = localDate(today);
  const start = `${today.getFullYear()}-01-01`;
  const panel = document.querySelector('[data-panel="expense_claims"]');
  panel.querySelector('[name="dateFrom"]').value = start;
  panel.querySelector('[name="dateTo"]').value = end;
}

function renderTools(tools) {
  const visible = tools.filter((tool) => TOOL_META[tool.id] || tool.id === "workflow_progress");
  els.toolList.replaceChildren(...visible.map((tool) => {
    const item = document.createElement(TOOL_META[tool.id] ? "button" : "div");
    if (item.tagName === "BUTTON") item.type = "button";
    item.className = `tool ${tool.id === state.selectedTool ? "active" : ""}`;
    item.dataset.toolId = tool.id;
    item.innerHTML = `<div><strong>${escapeHtml(tool.label)}</strong><p>${escapeHtml(tool.description)}</p></div><span class="tool-state ${tool.available === false ? "off" : ""}" title="${tool.available === false ? "待配置" : "可用"}"></span>`;
    if (TOOL_META[tool.id]) item.addEventListener("click", () => { selectTool(tool.id); document.querySelector(".query-card").scrollIntoView({ behavior: "smooth", block: "start" }); });
    return item;
  }));
}

function renderResult(payload) {
  const { result, plan } = payload;
  state.tableSort = { column: "", direction: 1 };
  state.tableRows = [];
  els.tool.textContent = `${result.label || plan.tool} · ${String(result.count ?? 0).padStart(2, "0")} ROWS`;
  els.summary.textContent = result.summary || "查询完成";
  const labels = TOOL_META[plan.tool]?.conditionLabels || {};
  els.plan.replaceChildren(...Object.entries(plan.arguments || {}).filter(([key, value]) => key !== "limit" && value !== "" && value != null).map(([key, value]) => {
    const tag = document.createElement("span"); tag.textContent = `${labels[key] || key}：${value === "sum_amount" ? "是" : value}`; return tag;
  }));
  if (result.workflow) { const pre = document.createElement("pre"); pre.textContent = JSON.stringify(result.workflow, null, 2); els.table.replaceChildren(pre); els.export.hidden = true; return; }
  if (result.aggregate) {
    const card = document.createElement("div"); card.className = "aggregate-card";
    card.innerHTML = `<span>${escapeHtml(result.aggregate.label)}</span><strong>${formatMoney(result.aggregate.value)}</strong><small>${result.aggregate.records} 笔单据${result.aggregate.partial ? " · 汇总达到上限" : " · 已完整汇总"}</small>`;
    els.table.append(card);
  }
  if (result.statistics) renderStatistics(result.statistics, plan.tool);
  if (!result.rows?.length) {
    if (!result.aggregate && !result.statistics) els.table.replaceChildren(document.querySelector("#empty-template").content.cloneNode(true));
    else if (result.statistics) els.table.append(document.querySelector("#empty-template").content.cloneNode(true));
    els.export.hidden = true;
    return;
  }
  renderResultTable(result);
  els.export.hidden = false;
}

function renderResultTable(result) {
  els.table.querySelector("table")?.remove();
  const table = document.createElement("table");
  const thead = document.createElement("thead"); const headRow = document.createElement("tr");
  result.columns.forEach((column) => {
    const th = document.createElement("th");
    th.scope = "col";
    const active = state.tableSort.column === column;
    th.setAttribute("aria-sort", active ? (state.tableSort.direction === 1 ? "ascending" : "descending") : "none");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "table-sort";
    button.setAttribute("aria-label", `按${column}${active && state.tableSort.direction === -1 ? "降序" : "升序"}排序`);
    const label = document.createElement("span"); label.textContent = column;
    const indicator = document.createElement("span");
    indicator.className = "table-sort-indicator";
    indicator.setAttribute("aria-hidden", "true");
    indicator.textContent = active ? (state.tableSort.direction === 1 ? "↑" : "↓") : "↕";
    button.append(label, indicator);
    button.addEventListener("click", () => {
      state.tableSort = {
        column,
        direction: active ? state.tableSort.direction * -1 : 1,
      };
      renderResultTable(result);
    });
    th.append(button); headRow.append(th);
  });
  thead.append(headRow); table.append(thead);
  const tbody = document.createElement("tbody");
  state.tableRows = sortRows(result.rows, state.tableSort);
  state.tableRows.forEach((row) => {
    const tr = document.createElement("tr");
    result.columns.forEach((column) => { const td = document.createElement("td"); td.textContent = formatCell(row[column], column); tr.append(td); });
    tbody.append(tr);
  });
  table.append(tbody); els.table.append(table);
}

function sortRows(rows, sort) {
  if (!sort.column) return [...rows];
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const comparison = compareCell(left.row[sort.column], right.row[sort.column], sort.column);
    return comparison ? comparison * sort.direction : left.index - right.index;
  }).map(({ row }) => row);
}

function compareCell(left, right, column) {
  const leftEmpty = left == null || left === "";
  const rightEmpty = right == null || right === "";
  if (leftEmpty || rightEmpty) return leftEmpty && rightEmpty ? 0 : (leftEmpty ? 1 : -1);
  if (/日期|时间/.test(column)) {
    const leftTime = Date.parse(String(left));
    const rightTime = Date.parse(String(right));
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  }
  if (/金额|数量|天数|发票数|单数|内码|库存/.test(column)) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  }
  return String(left).localeCompare(String(right), "zh-CN", { numeric: true, sensitivity: "base" });
}

function renderStatistics(statistics, tool = "") {
  if (tool === "inventory_cycle" || statistics.type === "inventory_cycle") {
    renderInventoryCycleStatistics(statistics);
    return;
  }
  if (tool === "receivable_aging" || statistics.type === "receivable_aging") {
    renderReceivableAgingStatistics(statistics);
    return;
  }
  if (tool === "overdue_risk_combined" || statistics.type === "overdue_risk_combined") {
    renderCombinedRiskStatistics(statistics);
    return;
  }
  const strip = document.createElement("section");
  strip.className = "aging-summary";
  strip.setAttribute("aria-label", "发票账龄汇总");
  const items = [
    ["未回款金额", formatMoney(statistics.unpaidAmount), `${statistics.subprojectCount} 个销售子项目`, "primary"],
    ["已收款金额", formatMoney(statistics.receivedAmount), "收款单减退款单"],
    ["收款未核销金额", formatMoney(statistics.paymentUnreconciledAmount), "已收款但尚未匹配应收"],
    ["应收未收款金额", formatMoney(statistics.receivableOutstandingAmount), "已形成应收但尚未收款"],
    ["未生成应收金额", formatMoney(statistics.unreceiptedInvoiceAmount), `${statistics.unreceiptedCount} 个（完全未形成 ${statistics.fullyUnreceiptedCount} 个）`],
    ["涉及客户", `${statistics.customerCount} 家`, `截至 ${statistics.asOfDate}`],
    ["完全未回款", `${statistics.completelyUnpaidCount} 个`, formatMoney(statistics.completelyUnpaidAmount)],
    ["部分回款未结清", `${statistics.partiallyPaidCount} 个`, formatMoney(statistics.partiallyPaidAmount)],
    ["最长超期发票账龄", `${statistics.oldestDays} 天`, "以子项目第一张超期发票开票日期起算"],
  ];
  items.forEach(([label, value, note, variant]) => {
    const item = document.createElement("div");
    item.className = `aging-stat${variant ? ` ${variant}` : ""}`;
    if (variant === "primary") item.dataset.threshold = `${statistics.minimumDays + 1}+`;
    const labelNode = document.createElement("span"); labelNode.textContent = label;
    const valueNode = document.createElement("strong"); valueNode.textContent = value;
    const noteNode = document.createElement("small"); noteNode.textContent = note;
    item.append(labelNode, valueNode, noteNode); strip.append(item);
  });
  els.table.append(strip);
}

function renderReceivableAgingStatistics(statistics) {
  const strip = document.createElement("section");
  strip.className = "aging-summary";
  strip.setAttribute("aria-label", "应收账龄汇总");
  const items = [
    ["应收未收款金额", formatMoney(statistics.outstandingAmount), `${statistics.subprojectCount} 个销售子项目`, "primary"],
    ["应收金额", formatMoney(statistics.receivableAmount), `${statistics.receivableBillCount} 张应收单`],
    ["应收已收款金额", formatMoney(statistics.receivedAmount), "已分配到应收单的回款"],
    ["应收未开票金额", formatMoney(statistics.unbilledAmount), `${statistics.unbilledCount} 个销售子项目`],
    ["涉及客户", `${statistics.customerCount} 家`, `截至 ${statistics.asOfDate}`],
    ["完全未回款", `${statistics.fullyUnpaidCount} 个`, formatMoney(statistics.fullyUnpaidAmount)],
    ["部分回款未结清", `${statistics.partiallyPaidCount} 个`, formatMoney(statistics.partiallyPaidAmount)],
    ["最长应收账龄", `${statistics.oldestDays} 天`, "以最早未收款应收单日期起算"],
  ];
  items.forEach(([label, value, note, variant]) => {
    const item = document.createElement("div");
    item.className = `aging-stat${variant ? ` ${variant}` : ""}`;
    if (variant === "primary") item.dataset.threshold = `${statistics.minimumDays + 1}+`;
    const labelNode = document.createElement("span"); labelNode.textContent = label;
    const valueNode = document.createElement("strong"); valueNode.textContent = value;
    const noteNode = document.createElement("small"); noteNode.textContent = note;
    item.append(labelNode, valueNode, noteNode); strip.append(item);
  });
  els.table.append(strip);
}

function renderCombinedRiskStatistics(statistics) {
  const strip = document.createElement("section");
  strip.className = "aging-summary";
  strip.setAttribute("aria-label", "超期风险合并汇总");
  const items = [
    ["最终超期风险金额", formatMoney(statistics.finalRiskAmount), `${statistics.subprojectCount} 个销售子项目`, "primary"],
    ["发票口径风险", formatMoney(statistics.invoiceRiskAmount), `超过 ${statistics.invoiceDays} 天`],
    ["应收口径风险", formatMoney(statistics.receivableRiskAmount), `超过 ${statistics.receivableDays} 天`],
    ["采用发票口径", `${statistics.invoiceSelectedCount} 个`, formatMoney(statistics.invoiceSelectedAmount)],
    ["采用应收口径", `${statistics.receivableSelectedCount} 个`, formatMoney(statistics.receivableSelectedAmount)],
    ["涉及客户", `${statistics.customerCount} 家`, `截至 ${statistics.asOfDate}`],
  ];
  items.forEach(([label, value, note, variant]) => {
    const item = document.createElement("div");
    item.className = `aging-stat${variant ? ` ${variant}` : ""}`;
    const labelNode = document.createElement("span"); labelNode.textContent = label;
    const valueNode = document.createElement("strong"); valueNode.textContent = value;
    const noteNode = document.createElement("small"); noteNode.textContent = note;
    item.append(labelNode, valueNode, noteNode); strip.append(item);
  });
  els.table.append(strip);
}

function renderInventoryCycleStatistics(statistics) {
  const strip = document.createElement("section");
  strip.className = "cycle-summary";
  strip.setAttribute("aria-label", "库存周期汇总");
  const items = [
    ["当前库存量", formatQuantity(statistics.totalQuantity), "公司仓 + 项目仓 + 客户仓基本单位", "primary"],
    ["公司仓库存", formatQuantity(statistics.companyQuantity), `${statistics.companyRowCount} 条库存明细`],
    ["项目仓库存", formatQuantity(statistics.projectQuantity), `${statistics.projectRowCount} 条库存明细`],
    ["客户仓待签收", formatQuantity(statistics.customerQuantity), `${statistics.customerRowCount} 条库存明细`],
    ["最长库存周期", `${statistics.oldestDays} 天`, `截至 ${statistics.asOfDate}`],
    ["链路核对", statistics.unmatchedCount ? `${statistics.unmatchedCount} 条待核对` : "已对齐", statistics.unmatchedCount ? "请查看数据状态列" : "单据与即时库存已匹配", statistics.unmatchedCount ? "caution" : ""],
  ];
  items.forEach(([label, value, note, variant]) => {
    const item = document.createElement("div");
    item.className = `cycle-stat${variant ? ` ${variant}` : ""}`;
    const labelNode = document.createElement("span"); labelNode.textContent = label;
    const valueNode = document.createElement("strong"); valueNode.textContent = value;
    const noteNode = document.createElement("small"); noteNode.textContent = note;
    item.append(labelNode, valueNode, noteNode); strip.append(item);
  });
  els.table.append(strip);
}

function setLoading(loading) { els.button.disabled = loading; els.button.querySelector("span").textContent = loading ? "正在查询" : TOOL_META[state.selectedTool].action; }
function formatCell(value, column) { if (value == null || value === "") return "—"; if (/金额/.test(column) && Number.isFinite(Number(value))) return formatMoney(value); if (/(库龄|待签收|库存周期)/.test(column) && Number.isFinite(Number(value))) return `${value} 天`; if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10); if (typeof value === "object") return JSON.stringify(value); return String(value); }
function formatMoney(value) { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(Number(value) || 0); }
function formatQuantity(value) { return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(Number(value) || 0); }
function localDate(date) { const offset = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return offset.toISOString().slice(0, 10); }
async function api(url, options = {}) { const response = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw Object.assign(new Error(payload.message || `请求失败 (${response.status})`), payload); return payload; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function exportCsv() { const result = state.lastResult; const rows = Array.isArray(state.tableRows) ? state.tableRows : result?.rows; if (!result?.columns?.length || !rows?.length) return; const cells = (values) => values.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(","); const csv = "\ufeff" + [cells(result.columns), ...rows.map((row) => cells(result.columns.map((column) => row[column])))].join("\n"); const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = `${result.label || "kingdee-query"}-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url); }
