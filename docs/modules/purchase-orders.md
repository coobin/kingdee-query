# 采购订单

## 模块定义

| 项目 | 内容 |
| --- | --- |
| 工具 ID | `purchase_orders` |
| 金蝶表单 | `PUR_PurchaseOrder` |
| 数据粒度 | 采购订单单据头；当前目录字段均为单据头字段，业务上按一单一行理解 |
| 默认排序 | `FDate DESC,FBillNo DESC` |
| 页面入口 | 单据编号、供应商名称、开始日期、结束日期至少填写一项 |

## 数据来源与字段字典

| 展示字段 | 类型 | 金蝶字段 | 说明 |
| --- | --- | --- | --- |
| 单据编号 | 文本 | `FBillNo` | 采购订单业务单号 |
| 业务日期 | 日期 | `FDate` | 采购订单业务日期 |
| 采购组织 | 文本 | `FPurchaseOrgId.FName` | 采购组织名称 |
| 供应商编码 | 文本 | `FSupplierId.FNumber` | 目录返回字段，页面和导出可展示 |
| 供应商 | 文本 | `FSupplierId.FName` | 供应商名称 |
| 审核状态 | 枚举文本 | `FDocumentStatus` | `Z` 暂存、`A` 已创建、`B` 审核中、`C` 已审核、`D` 重新审核；未知值显示“其他状态” |
| 关闭状态 | 原始枚举 | `FCloseStatus` | 当前没有配置状态码中文映射，按金蝶返回值展示 |
| 价税合计 | 金额 | `FBillAllAmount` | 采购订单返回的价税合计 |
| 创建人 | 文本 | `FCreatorId.FName` | 创建人名称 |

## 查询参数

| 外部参数 | 页面 | 金蝶筛选字段 | 匹配方式 | 备注 |
| --- | --- | --- | --- | --- |
| `billNumber` | 是 | `FBillNo` | 精确 |  |
| `supplierNumber` | 否 | `FSupplierId.FNumber` | 精确 | 结构化 API 可用 |
| `supplierName` | 是 | `FSupplierId.FName` | 包含 |  |
| `organizationName` | 否 | `FPurchaseOrgId.FName` | 包含 |  |
| `creatorName` | 否 | `FCreatorId.FName` | 包含 |  |
| `dateFrom` | 是 | `FDate` | 大于等于 | 包含开始日 |
| `dateTo` | 是 | `FDate` | 小于结束日的下一天 | 包含结束日 |

服务端要求至少提供一个有效筛选条件。日期按业务日期筛选，结束日期包含当天。

## 口径、权限和限制

- 金额使用采购订单价税合计，不应与入库金额、采购发票金额、付款金额或应付余额混用。
- 供应商编码是目录字段，但页面是否展示由返回列配置决定；金蝶内码不对外展示。
- 结果受当前金蝶用户的数据权限、采购组织权限和 Query Hub 模块访问名单约束。
- 返回行数受 `limit` 和服务端 `KINGDEE_MAX_ROWS` 共同限制，达到上限时结果可能不完整。
