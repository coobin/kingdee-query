module.exports = function openapi(config) {
  return {
    openapi: "3.0.3",
    info: { title: "Kingdee Query Hub API", version: "0.1.0", description: "供 Dify 调用的受控只读查询接口。请求必须携带 Bearer API Key 和最终用户金蝶账号。" },
    servers: [{ url: config.appBaseUrl }],
    paths: {
      "/api/dify/v1/query": {
        post: {
          operationId: "queryKingdee",
          summary: "查询金蝶业务数据",
          description: "可传自然语言 query，也可传确定性的 tool 和 arguments。库存等查询必须有限定条件。",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: config.difyUserHeader, in: "header", required: false, schema: { type: "string" }, description: "最终用户的金蝶登录账号；也可改用请求体 user 字段" }],
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object",
            properties: {
              query: { type: "string", example: "查询物料 A100 在原料仓的库存" },
              user: { type: "string", description: "最终用户的金蝶登录账号；未传请求头时必填" },
              tool: { type: "string", enum: ["inventory", "inventory_cycle", "sales_orders", "overdue_receivables", "receivable_aging", "overdue_risk_combined", "purchase_orders", "supplier_purchase_analysis", "personnel_cost", "expense_claims", "workflow_progress"] },
              arguments: { type: "object", additionalProperties: true },
            }
          } } } },
          responses: { 200: { description: "查询结果" }, 400: { description: "查询条件不完整" }, 401: { description: "认证失败" }, 502: { description: "金蝶接口错误" } }
        }
      },
      "/api/dify/v1/catalog": { get: { operationId: "listKingdeeTools", summary: "列出可用查询工具", security: [{ bearerAuth: [] }], parameters: [{ name: config.difyUserHeader, in: "header", required: true, schema: { type: "string" } }], responses: { 200: { description: "工具目录" } } } }
    },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } }
  };
};
