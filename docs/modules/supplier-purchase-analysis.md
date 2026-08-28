# 供应商采购分析

## 模块概览

- 工具 ID：`supplier_purchase_analysis`
- 主统计粒度：供应商（供应商编码优先；编码缺失时使用供应商名称）
- 明细粒度：采购订单明细行；供应商详情同时提供主数据画像、月度、物料和采购订单四个视图
- 默认期间：当年 1 月 1 日至当前业务日期
- 期间上限：366 天，`dateTo` 包含当天
- 金额币别：优先使用各业务对象的本位币金额字段；页面显示人民币样式仅用于格式化，不代表发生了币别换算
- 权限：该模块默认受限（`restrictedByDefault=true`）；管理员需将允许查看的金蝶用户名加入模块名单。每个来源均以当前 SSO 用户的金蝶账号查询，再叠加 Query Hub 模块权限名单

## 外部参数

| 参数 | 说明 |
| --- | --- |
| `dateFrom` | 开始日期，格式 `YYYY-MM-DD`，必填（页面默认填入当年 1 月 1 日） |
| `dateTo` | 结束日期，格式 `YYYY-MM-DD`，必填且不得早于开始日期 |
| `supplierNumber` | 供应商编码，精确匹配；点击排行中的供应商时由页面自动填入 |
| `supplierName` | 供应商名称，包含匹配 |
| `organizationName` | 组织名称，包含匹配；订单、收料/入库/退料、应付/付款和采购发票分别按各自对象的采购组织、库存组织、付款组织或采购组织筛选 |

## 来源和已核验字段

下列字段已通过金蝶 `QueryBusinessInfo` 元数据核验，并用真实 `ExecuteBillQuery` 请求验证字段标识和日期、状态过滤。明细字段在金蝶查询中以业务对象可识别的同名字段返回，服务端再映射为公开中文列。

| 来源 | FormId | 主要字段 | 默认状态口径 |
| --- | --- | --- | --- |
| 采购订单 | `PUR_PurchaseOrder` | `FBillNo`、`FDate`、`FSupplierId`、`FPurchaseOrgId`、`FDocumentStatus`、`FCancelStatus`、`FQty`、`FBaseUnitQty`、`FPrice`、`FAllAmount_LC`、`FBASESTOCKINQTY`、`FBASEMRBQTY`、`FDeliveryLastDate` | 纳入 `B/C/D`（审核中、已审核、重新审核），排除作废 |
| 收料单 | `PUR_ReceiveBill` | `FBillNo`、`FDate`、`FSupplierId`、`FBaseUnitQty`、`FInStockBaseQty`、`FReceiveBaseQty`、`FAllAmount_LC`、`FOrderBillNo`、`FSrcBillNo` | 仅已审核且未作废 |
| 采购入库 | `STK_InStock` | `FBillNo`、`FDate`、`FSupplierId`、`FBaseUnitQty`、`FAllAmount_LC`、`FSRCBillNo` | 仅已审核且未作废 |
| 采购退料 | `PUR_MRB` | `FBillNo`、`FDate`、`FSupplierID`、`FBASEUNITQTY`、`FRMREALQTY`、`FALLAMOUNT_LC`、`FSRCBillNo` | 仅已审核且未作废 |
| 应付单 | `AP_PAYABLE` | `FBillNo`、`FDATE`、`FSUPPLIERID`、`FALLAMOUNTFOR`、`FALLAMOUNT`、`FNORECEIVEAMOUNT`、`FNOINVOICEAMOUNT` | 仅已审核且未作废 |
| 付款单 | `AP_PAYBILL` | `FBillNo`、`FDATE`、`FCONTACTUNITTYPE`、`FCONTACTUNIT`、`FPAYTOTALAMOUNTFOR_H`、`FREALPAYAMOUNTFOR_H`、`FPAYTOTALAMOUNT_H`、`FREALPAYAMOUNT_H` | 仅已审核、未作废且往来单位类型为供应商 |
| 采购发票 | `IV_PURCHASEIC` | `FBillNo`、`FDATE`、`FSUPPLIERID`、`FALLAMOUNTFOR`、`FALLAMOUNT`、`FREDBLUE` | 仅已审核且未作废；红字按负数净额化 |
| 供应商主数据（可选） | `BD_Supplier` | `FNumber`、`FName`、`FSupplierClassify`、`FSupplierGrade`、`FBusinessStatus`、`FPayCurrencyId`、`FPayCondition`、`FInvoiceType`、`FStartDate`、`FEndDate` | 仅启用供应商；用于补充排行和明细画像，不会把无交易供应商加入期间排行 |
| 质量检验（可选） | `QM_INSPECTBILL` | `FBillNo`、`FDate`、`FSupplierId`、`FBaseInspectQty`、`FBaseQualifiedQty`、`FBaseUnqualifiedQty` | 仅已审核且未作废；需账套购买质量管理模块 |

## 指标口径

- **订单金额**：采购订单明细优先取 `FAllAmount_LC`，缺少明细金额时按采购订单号去重后取表头 `FBillAllAmount_LC`。
- **净采购金额**：订单金额 − 采购退料价税合计（本位币）。退料金额本身仍以正数展示，便于核对。
- **入库数量**：优先来自 `STK_InStock` 的采购基本数量；该来源不可用时回退到采购订单累计入库数量。
- **到货数量**：来自 `PUR_ReceiveBill` 的采购基本数量，不与入库数量混合。
- **入库率**：入库数量 ÷ 采购数量 × 100%。分母为 0 时显示 0%；因为入库单按本次期间统计、可能包含上期订单的到货，期间入库率可能超过 100%，页面保留原始比例，不做截断。
- **逾期未入库数量**：采购订单数量 − 入库数量的正数部分，且最晚交货日期早于统计结束日；未到期的未入库数量仍会在详情中保留。
- **应付金额 / 未开票金额**：来自 `AP_PAYABLE` 的本位币价税合计和未开票核销金额。应付单表头金额按应付单号去重。
- **采购发票金额**：来自 `IV_PURCHASEIC`；同一发票号按表头去重，红字标识为 `1` 且金额为正时转为负数。
- **已付款金额**：来自供应商付款单的实付金额（本位币），同一付款单号按表头去重。
- **付款覆盖率**：已付款金额 ÷ 应付金额 × 100%。
- **价格变化**：按供应商-物料的含税单价，以期间内最早和最晚价格计算百分比变化；不足两个价格点时显示 0%。
- **质量合格率**：`FBaseQualifiedQty ÷ FBaseInspectQty × 100%`。质量模块不可用时显示为空，并在数据来源状态中说明原因。
- **风险等级**：交付逾期、退料率不低于 5%、物料价格上涨不低于 10%、质检不合格数量大于 0 等内部信号组合；这不是外部信用评级。
- **前五家集中度**：按订单金额排序后，前五家供应商订单金额 ÷ 全部供应商订单金额。

## 完整性和降级行为

每个来源均使用 `TopRowCount=0` 和分页读取，页面不会把 `100` 行展示上限当成汇总扫描上限。采购订单是主来源；主来源失败时查询直接失败并记录审计。收料、入库、退料、应付、付款、发票、供应商主数据和质量来源单独记录状态：

- 来源可查询但期间无记录：标记为“已读取、0 行”，不视为错误。
- 来源无权限、字段不适配或模块未购买：标记为“不可用”，结果返回 `partial=true`，但其他来源继续汇总。
- 质量管理模块未购买时，质量合格率为空，不把空值当作 0% 不合格率。
- 供应商主数据不可用时，交易金额和数量仍可汇总，排行中的画像列留空；主数据只为期间内已发生交易的供应商补充信息。
- 详情查询会重新按供应商编码和同一期间读取来源，保证点击排行后的明细与汇总口径一致。

## 页面和接口输出

`rows` 返回供应商排行和采购金额、数量、入库、退料、应付、发票、付款、价格、交付、质量、风险及主数据画像列；`statistics` 返回期间总额、供应商数、订单数、集中度、主数据匹配数和可用来源；当请求携带 `supplierNumber` 时，`details` 追加主数据画像、月度趋势、物料构成、采购订单和异常提示。服务端不返回原始金蝶内码、银行字段、密钥或任意用户提交的字段表达式。
