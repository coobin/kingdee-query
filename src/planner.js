function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function localPlan(question) {
  const text = String(question || "").trim();
  if (!text) throw Object.assign(new Error("请输入要查询的内容。"), { statusCode: 400 });
  const arguments_ = { limit: 50 };
  let tool;
  if (/审批|审核|流程|到哪|进度/.test(text)) tool = "workflow_progress";
  else if (/报销|费用单/.test(text)) tool = "expense_claims";
  else if (/采购|供应商/.test(text)) tool = "purchase_orders";
  else if (/库存周期|库存库龄|库存账龄|呆在仓库|呆滞物料|待签收/.test(text)) tool = "inventory_cycle";
  else if (/合并.*(?:超期|账龄)|(?:开票|发票).*(?:和|与|及).*(?:应收)|应收.*(?:和|与|及).*(?:开票|发票)|两个口径|双口径/.test(text)) tool = "overdue_risk_combined";
  else if (/按应收|应收单(?:超期|账龄|维度)|应收单和收款|应收和收款/.test(text)) tool = "receivable_aging";
  else if (/未回款|没回款|未收款|超期应收|应收账龄|账龄|开票.*(?:未收|未回|没回)|应收.*未结清/.test(text)) tool = "overdue_receivables";
  else if (/销售|客户|订单/.test(text)) tool = "sales_orders";
  else if (/库存|仓库|物料|存量/.test(text)) tool = "inventory";
  else throw Object.assign(new Error("暂时无法判断你要查询库存、订单、超期未回款、报销还是审批进度，请说得具体一点。"), { statusCode: 400 });

  const quoted = [...text.matchAll(/[“\"']([^”\"']{1,40})[”\"']/g)].map((match) => match[1]);
  const bill = text.match(/(?:单号|编号|订单|报销单)\s*[：:=是为]?\s*([A-Za-z]{1,12}[-_]?\d{3,})/i);
  const material = text.match(/(?:物料|产品|商品)(?:编码|编号)?\s*[：:=是为]?\s*([A-Za-z0-9._-]{2,40})/i);
  const warehouse = text.match(/(?:仓库|库房)\s*[：:=是为]?\s*([^，。,.\s]{1,20})/);
  const applicant = text.match(/(?:申请人|报销人|员工)\s*[：:=是为]?\s*([^，。,.\s]{1,20})/);
  const explicitDates = [...text.matchAll(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/g)]
    .map((match) => `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`);
  const today = new Date();
  if (/今天/.test(text)) arguments_.dateFrom = arguments_.dateTo = dateString(today);
  if (/本月|这个月/.test(text)) {
    arguments_.dateFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
    arguments_.dateTo = dateString(today);
  }
  if (/今年|本年度|这个年度/.test(text)) {
    arguments_.dateFrom = `${today.getFullYear()}-01-01`;
    arguments_.dateTo = dateString(today);
  }
  if (/最近一周|近一周/.test(text)) {
    const from = new Date(today); from.setDate(from.getDate() - 7);
    arguments_.dateFrom = dateString(from); arguments_.dateTo = dateString(today);
  }
  if (explicitDates[0]) arguments_.dateFrom = explicitDates[0];
  if (explicitDates[1]) arguments_.dateTo = explicitDates[1];

  if (bill) arguments_.billNumber = bill[1];
  if (material) arguments_.materialNumber = material[1];
  if (warehouse) arguments_.warehouseName = warehouse[1];
  const subproject = text.match(/(?:销售)?子项目(?:编码|编号)?\s*[：:=是为]?\s*([A-Za-z0-9._-]{2,60})/i)
    || text.match(/项目(?:编码|编号)?\s*[：:=是为]?\s*([A-Za-z0-9._-]{2,60})/i);
  if (subproject) arguments_.subprojectNumber = subproject[1];
  if (applicant) arguments_.applicantName = applicant[1];
  if (/总金额|合计金额|金额合计|总计|一共.*(?:多少|金额)|累计.*金额/.test(text)) arguments_.aggregation = "sum_amount";
  if (tool === "overdue_receivables" || tool === "receivable_aging") {
    const minimumDays = text.match(/(?:超过|超|大于)?\s*(\d{1,4})\s*天/);
    const customer = text.match(/客户(?:名称)?\s*[：:=是为]?\s*([^，。,.;；\s]{1,30})/);
    const subproject = text.match(/(?:销售)?子项目(?:编码|编号)?\s*[：:=是为]?\s*([A-Za-z0-9._-]{2,60})/i)
      || text.match(/项目(?:编码|编号)?\s*[：:=是为]?\s*([A-Za-z0-9._-]{2,60})/i);
    if (minimumDays) arguments_.minimumDays = Number(minimumDays[1]);
    if (customer) arguments_.customerName = customer[1];
    if (subproject) arguments_.subprojectNumber = subproject[1];
    delete arguments_.dateFrom;
    delete arguments_.dateTo;
  }
  if (tool === "overdue_risk_combined") {
    const invoiceDays = text.match(/(?:开票|发票)[^\d]{0,8}(\d{1,4})\s*天/);
    const receivableDays = text.match(/应收[^\d]{0,8}(\d{1,4})\s*天/);
    const customer = text.match(/客户(?:名称)?\s*[：:=是为]?\s*([^，。,.;；\s]{1,30})/);
    const subproject = text.match(/(?:销售)?子项目(?:编码|编号)?\s*[：:=是为]?\s*([A-Za-z0-9._-]{2,60})/i)
      || text.match(/项目(?:编码|编号)?\s*[：:=是为]?\s*([A-Za-z0-9._-]{2,60})/i);
    if (invoiceDays) arguments_.invoiceDays = Number(invoiceDays[1]);
    if (receivableDays) arguments_.receivableDays = Number(receivableDays[1]);
    if (customer) arguments_.customerName = customer[1];
    if (subproject) arguments_.subprojectNumber = subproject[1];
    delete arguments_.dateFrom;
    delete arguments_.dateTo;
  }
  if (tool === "inventory_cycle") {
    const minimumDays = text.match(/(?:超过|超|大于|不少于|至少)?\s*(\d{1,4})\s*天/);
    if (minimumDays) arguments_.minimumDays = Number(minimumDays[1]);
    if (/仅?公司仓/.test(text)) arguments_.warehouseScope = "company";
    else if (/客户仓待签收|仅?客户仓/.test(text)) arguments_.warehouseScope = "customer";
    else if (/仅?项目仓/.test(text)) arguments_.warehouseScope = "project";
    delete arguments_.dateFrom;
    delete arguments_.dateTo;
  }
  if (tool === "inventory" && !arguments_.materialNumber && quoted[0]) arguments_.materialName = quoted[0];
  if (tool === "workflow_progress") {
    arguments_.formId = inferFormId(text);
    if (!arguments_.billNumber) {
      const looseBill = text.match(/\b([A-Za-z]{1,12}[A-Za-z0-9_-]*\d{3,})\b/);
      if (looseBill) arguments_.billNumber = looseBill[1];
    }
  }
  return { tool, arguments: arguments_, source: "local" };
}

function inferFormId(text) {
  if (/报销/.test(text)) return "ER_ExpReimbursement";
  if (/采购/.test(text)) return "PUR_PurchaseOrder";
  if (/销售/.test(text)) return "SAL_SaleOrder";
  return "";
}

async function aiPlan(question, catalog, config) {
  if (!config.ai.baseUrl || !config.ai.apiKey || !config.ai.model) return localPlan(question);
  const tools = Object.fromEntries(Object.entries(catalog).map(([id, item]) => [id, {
    description: item.description,
    arguments: Object.keys(item.filterFields).concat("limit", "aggregation（金额求和时固定为 sum_amount）"),
  }]));
  tools.workflow_progress = { description: "查询某张单据当前审批节点和历史", arguments: ["formId", "billNumber"] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  try {
    const response = await fetch(new URL("chat/completions", ensureSlash(config.ai.baseUrl)), {
      method: "POST",
      headers: { Authorization: `Bearer ${config.ai.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ai.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `你是金蝶只读查询规划器。只返回 JSON {"tool":"...","arguments":{...}}。不可生成 SQL，不可创造工具或字段。今天是 ${dateString(new Date())}。工具：${JSON.stringify(tools)}` },
          { role: "user", content: String(question).slice(0, 1000) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`AI planner HTTP ${response.status}`);
    const payload = await response.json();
    const parsed = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
    if (!tools[parsed.tool] || typeof parsed.arguments !== "object") throw new Error("AI planner returned invalid tool");
    return { ...parsed, source: "ai" };
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", message: "planner.fallback", error: error.message }));
    return localPlan(question);
  } finally { clearTimeout(timer); }
}

function ensureSlash(url) { return url.endsWith("/") ? url : `${url}/`; }

module.exports = { localPlan, aiPlan, inferFormId };
