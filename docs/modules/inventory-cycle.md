# 库存周期

## 业务口径

库存周期统计公司仓、项目仓和客户仓当前仍在库的物料。项目仓和客户仓必须在仓库基础资料中关联销售项目或销售子项目；未关联的项目仓、客户仓会被排除。周期链路为：

`收料入库 → 公司仓 / 项目仓 → 销售发货单（直接调拨） → 客户仓 → 客户签收单`

公司仓库龄表示当前物料进入公司仓后，到查询日的停留天数；项目仓库龄表示进入项目仓后，到查询日或发货前的停留天数；客户仓待签收表示直接调拨进入客户仓后，到查询日仍未签收的天数。总库存周期仍从最早收料入库日期计算。

## 数据来源

| 来源 | FormId | 关键字段 |
| --- | --- | --- |
| 即时库存 | `STK_Inventory` | `FStockId`、`FMaterialId`、`FLot`、`FBaseQty` |
| 收料入库 | `STK_InStock` | `FBillNo`、`FDate`、`FStockId`、`FMaterialId`、`FBaseUnitQty`、`FLot` |
| 销售发货单 | `STK_TransferDirect` | `FBillNo`、`FDate`、`FSrcStockId`、`FDestStockId`、`FBaseQty`、`FLot`、`FDestLot` |
| 客户签收单 | `SAL_OUTSTOCK` | `FBillNo`、`FDate`、`FStockID`、`FMaterialID`、`FBaseUnitQty`、`FLot` |
| 仓库基础资料 | `BD_STOCK` | `FNumber`、`FName`、销售项目、销售子项目 |

客户签收单的物流字段和 `F_PARA_SignQty`、`F_PARA_RemainSignQty` 不参与库龄计算。单据关联优先使用来源单号、销售子项目、物料和批号组合匹配；库存层按入库先进先出分配。

## 输出字段

页面显示库存阶段、销售子项目、仓库、物料、批号、当前库存数量、收料入库日期、发货日期、公司仓库龄、项目仓库龄、客户仓待签收、总库存周期及三张单据编号。`数据状态` 用于提示库存与单据链路未完全匹配的明细。

## 查询限制

结果范围以 `STK_Inventory` 当前非零库存为准；库龄计算日为当前业务日。查询必须填写物料、销售子项目、仓库名称或明确的仓库范围，不能只填写最少库存周期；填写最少库存周期后，再按总库存周期达到该天数及以上筛选。
