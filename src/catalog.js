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

function publicCatalog(catalog, workflowEnabled, canAccess = () => true) {
  const tools = Object.entries(catalog).filter(([id]) => canAccess(id)).map(([id, item]) => ({
    id,
    label: item.label,
    description: item.description,
    filters: Object.keys(item.filterFields),
    columns: item.publicColumns || item.fields.map(([, label]) => label),
  }));
  if (canAccess("workflow_progress")) {
    tools.push({
      id: "workflow_progress",
      label: "审批进度",
      description: "通过金蝶标准只读接口查询我发起流程的当前节点和处理人",
      filters: ["billNumber"],
      columns: ["单据编号", "流程名称", "当前节点", "当前处理人", "节点到达时间", "发起时间", "状态"],
      available: true,
    });
  }
  return tools;
}

module.exports = { loadCatalog, publicCatalog };
