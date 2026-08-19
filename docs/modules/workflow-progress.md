# 审批进度

## 模块定义

| 项目 | 内容 |
| --- | --- |
| 工具 ID | `workflow_progress` |
| 金蝶表单 | `WF_ProcInstBill`（流程管理_流程实例） |
| 数据粒度 | 当前登录用户发起的在审流程；可选按单据编号缩小范围 |
| 启用条件 | 现有 WebAPI 应用和用户可读取 `WF_ProcInstBill` |
| 页面入口 | “我发起的流程”页签；单据编号可留空 |

## 请求数据字典

| 外部参数 | 用途 | 类型 | 说明 |
| --- | --- | --- | --- |
| `scope` | 本人范围 | 固定文本 | 服务端固定为 `mine` |
| `billNumber` | 单据编号 | 文本 | 可选，按流程实例编号中的业务单据编号前缀过滤 |
| `limit` | 返回上限 | 整数 | 最大不超过服务端 `KINGDEE_MAX_ROWS` |

服务端固定查询 `WF_ProcInstBill`，并强制加入 `FOriginatorId.FUserAccount=当前金蝶账号` 和 `FStatus='2'`。调用方不能提交发起人、状态、`FormId`、字段列表、SQL 或任意金蝶过滤表达式。

## 输出数据

响应包含：

- `query.scope`、`query.status`、`query.billNumber`：本次查询条件；
- `columns`、`rows`：单据编号、流程名称、当前节点、当前处理人、节点到达时间、发起时间、状态；
- `truncated`：查询台达到返回上限时为 `true`；
- `summary`：说明本人在审流程数量。

节点、处理人和时间来自金蝶标准流程实例对象；本模块只做只读查询和字段转换，不执行审批操作。

## 权限、启用状态和限制

- 当前用户必须同时具备 Query Hub 模块权限、金蝶 WebAPI 登录权限和 `WF_ProcInstBill` 读取权限。
- 这是只读查询，不会提交、撤回、转交、催办或修改审批流程。
- 本模块不接受任意 SQL、任意 WebAPI 方法名、外部传入的发起人或状态。
