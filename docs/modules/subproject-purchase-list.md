# 子项目采购清单表

## 模块定义

| 项目 | 内容 |
| --- | --- |
| 工具 ID | `subproject_purchase_list` |
| 金蝶表单 | `PUR_PurchaseOrder` |
| 数据粒度 | 销售子项目下已审核的采购订单明细行（`FPOOrderEntry`，不限关闭状态） |
| 默认排序 | `F_PARA_SaleSubProId.FNumber ASC,FDate ASC,FBillNo ASC,FPOOrderEntry_FSeq ASC` |
| 页面入口 | 销售子项目编码或项目名称至少填写一项，可选补充供应商名称、物料名称和采购日期范围 |

## 数据来源与字段字典

| 展示字段 | 类型 | 金蝶字段 | 说明 |
| --- | --- | --- | --- |
| 销售子项目编码 | 文本 | `F_PARA_SaleSubProId.FNumber` | 采购订单明细关联的销售子项目编码 |
| 项目名称 | 文本 | `F_PARA_SaleSubProId.FName` | 优先取销售子项目名称；为空时回退取 `F_PARA_SaleProId.FName` |
| 采购订单号 | 文本 | `FBillNo` | 采购订单单据编号 |
| 采购日期 | 日期 | `FDate` | 格式化为 `YYYY-MM-DD` |
| 供应商 | 文本 | `FSupplierId.FName` | 供应商名称 |
| 物料名称 | 文本 | `FMaterialId.FName` | 采购物料名称 |
| 规格型号 | 文本 | `FMaterialId.FSpecification` | 物料规格型号 |
| 单位 | 文本 | `FUnitId.FName` | 采购单位名称 |
| 数量 | 数值 | `FQty` | 采购数量（保留最多 6 位小数） |
| 单价 | 金额 | `FTaxPrice` | 含税单价（保留最多 4 位小数） |
| 合价 | 金额 | `FAllAmount` | 明细价税合计（保留 2 位小数） |

## 查询参数

| 外部参数 | 页面 | 金蝶筛选字段 | 匹配方式 | 备注 |
| --- | --- | --- | --- | --- |
| `subprojectNumber` | 是 | `F_PARA_SaleSubProId.FNumber` | 包含 | 与 `subprojectName` 至少填一项 |
| `subprojectName` | 是 | `F_PARA_SaleSubProId.FName` / `F_PARA_SaleProId.FName` | 包含 | 同时匹配子项目名称和销售项目名称 |
| `supplierName` | 是 | `FSupplierId.FName` | 包含 | 可选 |
| `materialName` | 是 | `FMaterialId.FName` | 包含 | 可选 |
| `dateFrom` | 是 | `FDate` | 大于等于 | 可选，包含开始日 |
| `dateTo` | 是 | `FDate` | 小于结束日的下一天 | 可选，包含结束日 |

## 口径、权限和限制

- **单据状态口径**：服务端固定附加 `FDocumentStatus='C' AND FCancelStatus='A' AND FMRPTerminateStatus='A' AND F_PARA_SaleSubProId.FNumber<>''`，仅返回已审核、未作废且未业务终止并关联销售子项目的采购订单明细行，不限关闭状态。
- **金额口径**：单价取含税单价 `FTaxPrice`，合价取明细价税合计 `FAllAmount`，与合同含税单价 × 数量对齐。
- **分页与上限**：服务端使用 `TopRowCount=0` 完整分页读取，单次最多读取 5000 行；达到上限时返回 `truncated=true` 与 `partial=true` 并提示缩小查询范围。MCP 调用显式传入 `limit` 时，明细行按 `limit` 截取，同时保留全量汇总统计。
- **权限边界**：沿用当前登录用户的金蝶权限与 Query Hub 模块访问名单约束，不开放未授权单据。
