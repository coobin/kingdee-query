# 费用报销

## 模块定义

| 项目 | 内容 |
| --- | --- |
| 工具 ID | `expense_claims` |
| 金蝶表单 | `ER_ExpReimbursement` |
| 数据粒度 | 费用报销单单据头，一张报销单一行 |
| 默认排序 | `FDate DESC,FBillNo DESC` |
| 页面入口 | 页面默认填充本年度申请日期范围，并要求开始、结束日期 |

## 数据来源与字段字典

| 展示字段 | 类型 | 金蝶字段 | 说明 |
| --- | --- | --- | --- |
| 单据编号 | 文本 | `FBillNo` | 费用报销单号 |
| 申请日期 | 日期 | `FDate` | 报销申请日期 |
| 申请人 | 文本 | `FProposerID.FName` | 申请人名称；普通用户查询会强制绑定此字段 |
| 申请部门 | 文本 | `FRequestDeptID.FName` | 申请部门名称 |
| 申请组织 | 文本 | `FOrgID.FName` | 申请组织名称 |
| 审核状态 | 枚举文本 | `FDocumentStatus` | `Z` 暂存、`A` 已创建、`B` 审核中、`C` 已审核、`D` 重新审核；未知值显示“其他状态” |
| 单据总金额 | 金额 | `FExpAmountSum` | 报销单头总金额 |
| 审核日期 | 日期 | `FApproveDate` | 未审核单据可能为空 |

## 查询参数

| 外部参数 | 页面 | 金蝶筛选字段 | 匹配方式 | 备注 |
| --- | --- | --- | --- | --- |
| `billNumber` | 否 | `FBillNo` | 精确 | 结构化 API 可用 |
| `applicantNumber` | 否 | `FProposerID.FNumber` | 精确 | 普通用户不能借此切换查询对象 |
| `applicantName` | 否 | `FProposerID.FName` | 包含 | 普通用户仍会叠加本人范围 |
| `departmentName` | 否 | `FRequestDeptID.FName` | 包含 |  |
| `organizationName` | 否 | `FOrgID.FName` | 包含 |  |
| `dateFrom` | 是 | `FDate` | 大于等于 | 页面要求 |
| `dateTo` | 是 | `FDate` | 小于结束日的下一天 | 页面要求，包含结束日 |
| `status` | 否 | `FDocumentStatus` | 精确 | 传入金蝶状态码 |
| `aggregation` | 页面可选 | — | — | 固定值 `sum_amount`，汇总 `FExpAmountSum` |

## 权限、汇总和限制

- 普通用户始终追加 `FProposerID.FName=当前身份姓名`，提交其他申请人条件不能扩大范围；配置在 `KINGDEE_QUERY_SCOPE_ADMINS` 中的账号不追加本人条件，但仍受金蝶权限和其他筛选约束。
- 页面建议提供日期范围；结构化 API 的普通用户即使不提供日期，也只会落在本人范围内，服务端仍会按返回上限保护查询。
- `aggregation=sum_amount` 按实际扫描到的单据头 `FExpAmountSum` 求和，同时返回单据数量。达到 `KINGDEE_AGGREGATION_MAX_ROWS` 时 `aggregate.partial=true`，总金额可能不完整。
- 费用单头金额不是已付款金额、可报销余额或实际到账金额。审核日期为空不代表单据不存在，只表示金蝶当前没有返回审核日期。
