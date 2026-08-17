# 即时库存

## 模块定义

| 项目 | 内容 |
| --- | --- |
| 工具 ID | `inventory` |
| 金蝶表单 | `STK_Inventory` |
| 数据粒度 | 库存查询返回的明细行，通常由库存组织、物料、仓库、批次等维度决定 |
| 默认排序 | `FMaterialId.FNumber ASC` |
| 页面入口 | 物料编码必填 |

## 数据来源与字段字典

| 展示字段 | 类型 | 金蝶字段 | 说明 |
| --- | --- | --- | --- |
| 库存组织编码 | 文本 | `FStockOrgId.FNumber` | 库存组织编码 |
| 库存组织 | 文本 | `FStockOrgId.FName` | 库存组织名称 |
| 物料编码 | 文本 | `FMaterialId.FNumber` | 物料主数据编码 |
| 物料名称 | 文本 | `FMaterialId.FName` | 物料主数据名称 |
| 仓库编码 | 文本 | `FStockId.FNumber` | 仓库编码 |
| 仓库 | 文本 | `FStockId.FName` | 仓库名称 |
| 批号 | 文本 | `FLot.FNumber` | 非批次管理物料可能为空 |
| 基本库存数量 | 数值 | `FBaseQty` | 金蝶返回的基本单位数量；单位未在本查询中返回 |
| 辅助库存数量 | 数值 | `FSecQty` | 金蝶返回的辅助数量；辅助单位未在本查询中返回 |
| 生产日期 | 日期 | `FProduceDate` | 没有批次生产日期时可能为空 |
| 有效期至 | 日期 | `FExpiryDate` | 没有批次有效期时可能为空 |

## 查询参数

| 外部参数 | 页面 | 金蝶筛选字段 | 匹配方式 | 备注 |
| --- | --- | --- | --- | --- |
| `materialNumber` | 否，页面使用完整编码 | `FMaterialId.FNumber` | 精确 | 页面要求填写 |
| `materialName` | 否 | `FMaterialId.FName` | 包含 | 可供结构化 API 使用 |
| `warehouseNumber` | 否 | `FStockId.FNumber` | 精确 |  |
| `warehouseName` | 否 | `FStockId.FName` | 包含 |  |
| `organizationNumber` | 否 | `FStockOrgId.FNumber` | 精确 |  |
| `lotNumber` | 否 | `FLot.FNumber` | 精确 |  |

服务端要求至少形成一个有效筛选条件，避免无范围扫描。未登记的参数会被忽略，不会变成金蝶过滤表达式。

## 口径、权限和限制

- 查询在请求时读取金蝶即时库存，不是历史库存快照。
- 基本数量和辅助数量不能直接相加；缺少单位字段时，也不能跨物料或跨单位直接汇总。
- 数量不等同于锁库量、可用量、在途量或未来供应量，除非另有明确字段来源。
- 结果使用当前登录身份访问金蝶，并受库存组织、仓库、物料和其他金蝶数据权限约束。
- 返回行数受 `limit` 和服务端 `KINGDEE_MAX_ROWS` 共同限制，达到上限时结果可能不完整。
