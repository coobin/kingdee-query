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
              tool: { type: "string", enum: ["inventory", "inventory_cycle", "sales_orders", "sales_business_analysis", "overdue_receivables", "receivable_aging", "overdue_risk_combined", "purchase_orders", "supplier_purchase_analysis", "personnel_cost", "expense_claims", "workflow_progress"] },
              arguments: { type: "object", additionalProperties: true },
            }
          } } } },
          responses: { 200: { description: "查询结果" }, 400: { description: "查询条件不完整" }, 401: { description: "认证失败" }, 502: { description: "金蝶接口错误" } }
        }
      },
      "/api/dify/v1/analyze": {
        post: {
          operationId: "analyzeKingdeeOverdueRisk",
          summary: "分析超期风险查询结果",
          description: "先按受控查询读取超期风险，再调用 DeepSeek 生成只读分析。可选传入不超过 5 个销售子项目编码，获取单项目明细分析。",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: config.difyUserHeader, in: "header", required: false, schema: { type: "string" }, description: "最终用户的金蝶登录账号；也可改用请求体 user 字段" }],
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object",
            properties: {
              query: { type: "string", example: "分析当前超期风险，指出优先跟进项目" },
              user: { type: "string", description: "最终用户的金蝶登录账号；未传请求头时必填" },
              tool: { type: "string", enum: ["overdue_risk_combined"] },
              arguments: { type: "object", additionalProperties: true },
              subprojectNumbers: { type: "array", maxItems: 5, items: { type: "string" }, description: "可选；选择后分析这些销售子项目的发票、应收、核销、收款和退款证据" },
            },
          } } } },
          responses: { 200: { description: "AI 分析结果及结构化查询数据" }, 400: { description: "请求或选择条件不完整" }, 401: { description: "认证失败" }, 429: { description: "AI 请求频率受限" }, 502: { description: "AI 服务或金蝶接口错误" }, 503: { description: "AI 分析未配置" } },
        },
      },
      "/api/dify/v1/catalog": { get: { operationId: "listKingdeeTools", summary: "列出可用查询工具", security: [{ bearerAuth: [] }], parameters: [{ name: config.difyUserHeader, in: "header", required: true, schema: { type: "string" } }], responses: { 200: { description: "工具目录" } } } }
    },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } }
  };
};
