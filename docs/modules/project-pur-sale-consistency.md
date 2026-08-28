# 项目购销一致性

## 模块标识

- 工具 ID：`project_pur_sale_consistency`
- 金蝶报表 FormId：`PARA_PM_ProjectPurSaleRpt`
- 金蝶过滤 FormId：`PARA_ProjectPurSaleRptFilter`
- 查询服务：`Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.GetSysReportData`

这是对金蝶原“项目购销一致性报表”的同源读取。Query Hub 不重新拼接这张报表的 SQL，也不在本地重新计算金额；它只把已登记的字段、过滤模型和分页参数传回金蝶报表服务，再把位置行转换成公开列名。这样合同、应收/应付、收款/付款、票据和发票的行展开仍由金蝶原报表决定。

金蝶 `QueryBusinessInfo` 可以确认报表标识、名称和可用操作，但这张系统报表的 `Entrys` 不公开内部 SQL 或插件公式。因此下表将“主数据来源”和“原报表计算”明确区分：能从业务对象元数据和真实查询确认的字段标为“已确认”，由原报表服务计算或跨单据关联的字段标为“同源计算”。

## 数据粒度与行逻辑

报表不是“一行一个销售项目”的简单汇总表，而是以销售项目/销售子项目为锚点，按合同和后续往来单据展开的报表。相同销售子项目可能出现多行，区别来自“单据类型”和对应的单据编号；Query Hub 保留这一行结构，不去重、不把正负金额静默净额化、不把不同单据类型强行合并。

可观察到的单据类型包括销售合同、应收单、收款单和销售发票；采购侧对应的应付、付款和票据行由原报表服务按其内部关联返回。空字段表示该行不适用，并不代表原始单据金额为零。

## 返回字段口径

| API 字段 | 页面列 | 逻辑口径 | 证据级别 |
| --- | --- | --- | --- |
| `FORGNAME` | 组织 | 销售子项目关联业务组织名称 | 已确认主数据关系 |
| `FSALEDEPTNAME` | 销售部门 | 销售子项目关联销售部门名称 | 已确认主数据关系 |
| `FCUSTUSERNAME` | 客户经理 | 销售子项目关联客户经理 | 已确认主数据关系 |
| `FINDUSTRYNAME` | 行业 | 销售子项目行业辅助资料的显示值 | 已确认字段关系 |
| `FPROJECTTYPE` | 项目类型 | 销售子项目产业/项目类型；当前元数据枚举为 `A` 集成、`B` 服务、`C` 自研、`E` 集成(不含服务)、`F` 其他 | 已确认枚举 |
| `FOWNER` | 最终客户 | 销售子项目“业主单位”字段在报表中的显示列 | 已确认字段别名 |
| `FBUSINESSOWNER` | 项目归属 | 原报表的项目归属显示值 | 同源计算 |
| `FSALEPRONUMBER` | 销售项目编码 | 销售子项目 `FSaleProjectId` 的编码 | 已确认主数据关系 |
| `FSALEPRONAME` | 销售项目名称 | 销售项目主数据名称 | 已确认主数据关系 |
| `FSALESUBPRONUMBER` | 销售子项目编码 | `PARA_SaleSubProject.FBillNo` | 已确认业务对象字段 |
| `FSALESUBPRONAME` | 销售子项目名称 | `PARA_SaleSubProject.FName` | 已确认业务对象字段 |
| `FBEGINRECEIVEAMT` | 期初已收款金额 | 销售子项目初始已收款金额 | 已确认业务对象字段 |
| `FBEGININVOICEAMT` | 期初已开票金额 | 销售子项目初始已开票金额 | 已确认业务对象字段 |
| `FBEGINPAYAMT` | 期初已付款金额 | 销售子项目初始已付款金额 | 已确认业务对象字段 |
| `FBEGINRECEINVOICEAMT` | 期初已收票金额 | 销售子项目初始已收票金额 | 已确认报表列 |
| `FSALESUBDATE` | 子项目日期 | 销售子项目业务日期 | 已确认业务对象字段 |
| `FCUSTSUPPLIERNUMBER` | 客户/供应商编码 | 当前展开行往来单位的编码；销售行和采购行可能分别取客户或供应商 | 同源计算 |
| `FCUSTSUPPLIERNAME` | 客户/供应商名称 | 当前展开行往来单位的名称 | 同源计算 |
| `FCONTRACTTYPE` | 合同类型 | 当前合同关联行的合同类型 | 同源计算 |
| `FCONTRACTNO` | 合同号 | 当前合同关联行的合同编号 | 同源计算 |
| `FCONTRACTAMT` | 合同金额 | 当前合同关联行合同金额 | 同源计算 |
| `FREBATEAMT` | 返点金额 | 当前合同/项目关联的返点金额 | 同源计算 |
| `FBINDSUBPROAMT` | 集采绑定金额 | 集采合同或采购关联到当前销售子项目的金额 | 同源计算 |
| `FUNBINDSUBPROAMT` | 集采未绑定金额 | 原报表识别为未绑定当前销售子项目的集采金额 | 同源计算 |
| `FCONTRACTSIGNDATE` | 签订时间 | 当前合同的签订日期 | 同源计算 |
| `FRECEPAYCONDITION` | 收/付款条件 | 项目/合同关联的收付款条件文本 | 同源计算 |
| `FSERVICETERM` | 质保(月)/服务期限 | 当前合同关联的质保或服务期限 | 同源计算 |
| `FCONTRACTTAXRATE` | 合同税率% | 当前合同适用税率 | 同源计算 |
| `FCONTRACTTAXRATEAMT` | 合同税率金额 | 原报表按合同税率口径返回的金额列 | 同源计算 |
| `FPAYTYPE` | 单据类型 | 当前展开行所属单据类型，如销售合同、应收单、收款单或销售发票 | 已通过线上行验证；完整集合由原报表决定 |
| `FRECEPAYBILLNO` | 应收单/应付单号 | 应收或应付单据编号；不适用的单据行为空 | 同源计算 |
| `FRECEPAYAMT` | 应收/应付金额 | 当前应收或应付单据的金额 | 同源计算 |
| `FRECEPAYDATE` | 应收/应付时间 | 当前应收或应付单据日期 | 同源计算 |
| `FRECEPAYUNWRITEAMT` | 应收/应付未结算金额 | 当前应收或应付单据尚未结算的金额 | 同源计算 |
| `FACTRECEPAYBILLNO` | 收款单/付款单号 | 与当前项目往来关联的实际收款或付款单号 | 同源计算 |
| `FPAYNATURE` | 款项性质 | 实际收款或付款行的款项性质 | 同源计算 |
| `FACTRECEPAYAMT` | 收款/付款金额 | 实际收款或付款金额 | 同源计算 |
| `FACTRECEPAYDATE` | 收款/付款时间 | 实际收款或付款日期 | 同源计算 |
| `FSETTLETYPE` | 收/付款方式 | 实际收款或付款结算方式 | 同源计算 |
| `FBILLBILLNUMBER` | 应收/应付票据流水号 | 应收/应付票据在原报表中的流水号 | 同源计算 |
| `FBILLBILLNO` | 应收/应付票据号 | 应收/应付票据号码 | 同源计算 |
| `FBILLPARAMOUNT` | 票面金额 | 票据票面金额 | 同源计算 |
| `FBILLISSUEDATE` | 票据收/付票日 | 票据收票或付票日期 | 同源计算 |
| `FBILLDUEDATE` | 票据到期日期 | 票据到期日 | 同源计算 |
| `FBILLINAMT` | 票据入/出账金额 | 票据入账或出账金额 | 同源计算 |
| `FBILLINDATE` | 票据入/出账时间 | 票据入账或出账日期 | 同源计算 |
| `FINVOICEBILLNO` | 发票单据编号 | 关联发票单据编号 | 同源计算 |
| `FINVOICETAXRATE` | 发票单税率% | 关联发票的税率 | 同源计算 |
| `FINVOICETAXRATEAMT` | 发票单税率金额 | 原报表返回的发票税率金额列 | 同源计算 |
| `FBILLINGDATE` | 开票日期 | 关联发票开票日期 | 同源计算 |

## 可用筛选

页面和结构化 API 目前开放这些稳定可复现的筛选：

- `organizationNumber`：业务组织编码。默认使用当前账套原过滤器的默认组织；服务端先从 `ORG_Organizations` 解析 `FORGID/FNumber/FName`，再把完整基础资料对象传给报表。
- `projectNumber`：销售项目编码。服务端从 `PARA_ProjectView` 解析 `FID/FNumber/FName`。
- `subprojectNumber`：销售子项目编码。服务端从 `PARA_SaleSubProject` 解析 `FID/FBillNo/FName`。
- `departmentNumber`：销售部门编码。服务端从 `BD_Department` 解析 `FDEPTID/FNumber/FName`，并按业务组织匹配 `FUseOrgId.FNumber`，避免相同部门编码跨组织误选。
- `customerNumber`：客户编码。服务端从 `BD_Customer` 解析 `FCUSTID/FNumber/FName`，并按业务组织匹配 `FUseOrgId.FNumber`。
- `dateFrom`、`dateTo`：分别传给原过滤模型的 `FContractStartDate`、`FContractEndDate`，值为 `YYYY-MM-DD`。

原金蝶快捷过滤界面还显示“行业”辅助资料选择。该辅助资料在无状态 WebAPI 中需要金蝶内部的辅助资料序列化格式；已验证的标准基础资料对象格式不能稳定复现该过滤条件。因此当前入口不开放一个会被静默忽略的行业参数，行业仍完整返回在 `FINDUSTRYNAME` 列中。若后续需要行业筛选，应先从原页面抓取一组脱敏请求/响应并补充接口级回归测试。

## 返回上限与完整性

`count` 使用金蝶报表返回的 `RowCount`，`rows` 是当前请求返回的行，`truncated=true` 表示总行数超过返回上限。当前页面默认请求 200 行，服务端仍受 `KINGDEE_MAX_ROWS` 的安全上限约束；缩小项目、子项目或日期范围后再导出，避免把部分结果误当成完整报表。

## 权限边界

Query Hub 只登记这张报表的固定 FormId、固定 50 个 FieldKeys 和固定过滤字段。查询仍以当前登录人的金蝶身份执行，Query Hub 的模块权限只能进一步收紧，不能扩大金蝶原有组织或数据权限。
