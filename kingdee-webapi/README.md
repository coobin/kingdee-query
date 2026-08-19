# 金蝶只读工作流 WebAPI

这部分是给金蝶云星空 9.0.0.20240711 使用的自定义 WebAPI 源码。接口只返回当前登录用户自己发起、仍在审批中的流程，不接受外部传入发起人，也没有保存、提交、审核、撤回、转交等写操作。

## 接口

方法名：

```text
Company.K3.WebApi.WorkflowQuery.GetMyProgress,Company.K3.WebApi
```

服务地址：

```text
POST /K3Cloud/Company.K3.WebApi.WorkflowQuery.GetMyProgress,Company.K3.WebApi.common.kdsvc
```

参数是一个 JSON 字符串，支持：

```json
{"Scope":"Mine"}
```

也可以只查一张单据：

```json
{"Scope":"Mine","Number":"FYBX20260803000026","FormId":"ER_ExpReimbursement"}
```

## 发布前提

`WorkflowQuery.cs` 必须用与金蝶站点完全匹配的 9.0.0.20240711 SDK 编译，引用 `Kingdee.BOS.dll`、`Kingdee.BOS.App.dll`、`Kingdee.BOS.ServiceFacade.KDServiceFx.dll`、`Kingdee.BOS.WebApi.ServicesStub.dll`、`Newtonsoft.Json.dll`。没有对应 SDK 时不能在本机直接编译；不能把这段源码粘到 WebAPI 参数框里代替程序集。

编译后建议通过二开安装包导入站点，不要直接覆盖生产站点的标准组件。程序集名称和命名空间要保持 `Company.K3.WebApi`。

## 金蝶 WebUI 配置

程序集导入并重启应用站点后，在金蝶 WebUI 的 BOS 平台参数中：

1. 启用 WebAPI 功能权限控制、数据权限控制和 IP 白名单（如果当前环境已使用）。
2. 在允许的 API 中加入 `Company.K3.WebApi.WorkflowQuery.GetMyProgress`。
3. 将调用 Query Hub 的应用和对应员工加入允许用户/角色范围。
4. 保存后用金蝶 WebAPI 测试页先验证单个员工，再把方法名写入 Query Hub：

```env
KINGDEE_WORKFLOW_METHOD=Company.K3.WebApi.WorkflowQuery.GetMyProgress,Company.K3.WebApi
```

不要在 WebUI 中开放任意 SQL 或任意方法名；本接口已经把发起人固定为当前登录用户，外部只允许单据编号和表单号作为可选筛选条件。
