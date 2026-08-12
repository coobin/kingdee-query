const fs = require("fs");

function loadCatalog(filePath) {
  const catalog = JSON.parse(fs.readFileSync(filePath, "utf8"));
  for (const [key, item] of Object.entries(catalog)) {
    if (!item.formId || !Array.isArray(item.fields) || !item.filterFields) {
      throw new Error(`Invalid query catalog entry: ${key}`);
    }
  }
  return catalog;
}

function publicCatalog(catalog, workflowEnabled) {
  const tools = Object.entries(catalog).map(([id, item]) => ({
    id,
    label: item.label,
    description: item.description,
    filters: Object.keys(item.filterFields),
    columns: item.fields.map(([, label]) => label),
  }));
  tools.push({
    id: "workflow_progress",
    label: "审批进度",
    description: workflowEnabled ? "查询单据当前审批节点和历史" : "需要配置金蝶自定义工作流查询接口",
    filters: ["formId", "billNumber"],
    columns: [],
    available: workflowEnabled,
  });
  return tools;
}

module.exports = { loadCatalog, publicCatalog };
