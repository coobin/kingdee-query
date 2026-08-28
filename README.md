# Kingdee Query Hub

一个面向企业内部员工的金蝶云星空只读查询门户。它通过 SSO 获取当前用户身份，以该用户登录金蝶 WebAPI，并向网页和 Dify 提供受控的业务查询能力。

项目不会接收 SQL，也不会把任意 `FormId`、`FieldKeys` 或 `FilterString` 直接交给调用方。可查询对象、返回字段和筛选条件全部由服务端白名单控制。

## 功能

- 通过 Authelia、Nginx 或其他反向代理注入的可信请求头完成 SSO
- 提供独立的 `/login` 超级管理员登录入口和 `/admin` 权限设置界面
- 支持超级管理员注册 Passkey，并可切换为仅使用设备验证登录
- 可按查询模块配置查看人员，名单直接匹配 SSO 解析出的金蝶用户名
- 可新增、修改和删除超级管理员，并保证至少保留一个管理员
- 使用最终用户身份建立金蝶 `LoginByAppSecret` 会话，沿用其金蝶数据权限
- 提供库存、销售订单、项目购销一致性、发票账龄、应收账龄、超期风险、采购订单、供应商采购分析、人员成本和本人费用报销单查询
- 供应商采购分析按期间汇总采购订单、到货、入库、退料、应付、采购发票和付款，并补充启用供应商的分类/等级/业务状态画像，提供供应商排行、集中度、交付/价格风险和可点击的物料及订单明细
- 发票账龄以销售子项目为统计维度，以开票日期计算账龄，所有金额只覆盖超期发票；红蓝字发票先净额化，再按发票—应收匹配结果分摊已收款，区分已收款金额、收款未核销金额、未生成应收金额、应收未收款金额和未回款金额
- 费用报销单按单据头返回，一张单据一行，状态转换为中文
- 人员成本按员工编号归集已审核工资单实发金额与已审核费用报销核定金额，日期范围最长 366 天并完整分页读取
- 网页使用结构化查询表单，避免自然语言误判
- Dify API 仍支持常见中文问法，也可连接 OpenAI-compatible 模型进行查询规划
- 提供带 Bearer 认证的 Dify API 和 OpenAPI Schema
- 记录登录、退出、查询和管理操作审计日志，并在管理员 WebUI 中查看
- 使用金蝶标准只读对象查询本人发起流程的当前节点和处理人

## 工作方式

```text
浏览器 ── SSO 反向代理 ── Query Hub ── 金蝶云星空 WebAPI
                               │
Dify ───── Bearer API ─────────┘
```

网页不依赖 AI：用户选择业务类型并填写明确条件，前端直接调用已登记的查询工具。Dify API 可以显式传入工具和参数，也可以让 AI 或本地解析器把自然语言转换成工具调用。无论采用哪种入口，最终查询仍受服务端白名单和金蝶用户权限约束。

## 快速开始

要求 Node.js 20 或更高版本。

```bash
git clone git@github.com:coobin/kingdee-query.git kingdee-query-hub
cd kingdee-query-hub
cp .env.example .env
npm install
npm run check
npm start
```

填写 `.env` 中的金蝶账套、应用和认证配置。仅在本机开发时可以使用：

```env
AUTH_MODE=dev
```

生产环境会拒绝以 `dev` 模式启动。

## 环境变量

`.env` 已被 Git 忽略。不要把真实密钥、内网地址、账号或业务数据写入源码和提交历史。

| 变量 | 用途 |
| --- | --- |
| `APP_BASE_URL` | 对外访问地址，也用于生成 OpenAPI Server URL |
| `DOCKER_SUBNET` | Query Hub 专用 Docker 网段；部署前确认不与公司网络重叠 |
| `AUTH_MODE` | `trusted_headers` 或仅限开发的 `dev` |
| `AUTH_TRUSTED_PROXY_TOKEN` | Query Hub 与反向代理共享的随机密钥 |
| `REMOTE_*_HEADER` | SSO 身份请求头名称 |
| `KINGDEE_USERNAME_SOURCE` | 金蝶登录名取值来源 |
| `KINGDEE_QUERY_SCOPE_ADMINS` | 可查询授权范围的管理员账号，逗号分隔 |
| `DIFY_API_KEYS` | Dify 调用使用的 Bearer Key，逗号分隔 |
| `KINGDEE_BASE_URL` | 金蝶 K3Cloud WebAPI 根地址 |
| `KINGDEE_DBID` | 数据中心或账套 ID |
| `KINGDEE_APP_ID` | 第三方系统登录授权的应用 ID |
| `KINGDEE_APP_SECRET` | 第三方系统登录授权的应用密钥 |
| `KINGDEE_MAX_ROWS` | 普通查询最大返回行数 |
| `KINGDEE_REPORT_TIMEOUT_MS` | 系统报表查询超时时间，默认 120 秒 |
| `KINGDEE_QUERY_PAGE_SIZE` | 发票账龄按销售子项目分页时每页读取行数，默认 5000，最大 5000 |
| `KINGDEE_AGGREGATION_MAX_ROWS` | 其他汇总查询最大扫描行数；发票账龄按销售子项目分页读取 |
| `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL` | 可选的 OpenAI-compatible 查询规划模型 |
| `AUDIT_LOG_PATH` | 操作审计日志路径 |
| `AUDIT_MAX_BYTES` | 单个审计日志文件上限，默认 10 MiB |
| `AUDIT_MAX_FILES` | 保留的轮转日志文件数，默认 10 |
| `LOCAL_AUTH_DATA_PATH` | 超级管理员和模块权限文件路径；只保存加盐密码摘要，不保存明文密码 |
| `LOCAL_AUTH_SESSION_HOURS` | 超级管理员登录有效小时数，默认 8 小时 |
| `LOCAL_AUTH_COOKIE_SECURE` | HTTPS 部署时设为 `true`；未填写时根据 `APP_BASE_URL` 判断 |
| `PASSKEY_ENABLED` | 是否启用超级管理员 Passkey，默认 `true` |
| `PASSKEY_ORIGIN` | Passkey 使用的完整 HTTPS 来源，例如 `https://query.example.com`；本地 `localhost` 可用于开发 |
| `PASSKEY_RP_ID` | Passkey 依赖方 ID，通常填写访问域名，不含协议和路径 |
| `PASSKEY_RP_NAME` | Passkey 注册时显示的应用名称 |

建议使用以下命令分别生成代理共享密钥和 Dify Key：

```bash
openssl rand -hex 32
```

## SSO 与反向代理

生产环境使用 `AUTH_MODE=trusted_headers`。SSO 代理完成登录后应传递：

```text
Remote-User: 240001
Remote-Name: 张三
Remote-Email: zhangsan@example.com
Remote-Kingdee-Username: 240001
X-Auth-Proxy-Token: <随机共享密钥>
```

推荐显式传递 `Remote-Kingdee-Username`，并配置：

```env
KINGDEE_USERNAME_SOURCE=kingdee_header
```

生产端口不应绕过代理直接暴露给不可信网络。即使攻击者伪造 `Remote-*` 请求头，没有正确的 `AUTH_TRUSTED_PROXY_TOKEN` 也无法访问网页 API。

超级管理员从 `/login` 使用本地账号登录。管理员会话采用 `HttpOnly`、`SameSite=Lax` Cookie；连续登录失败会临时限制尝试。Passkey 只能在 HTTPS（或本机 localhost）来源下使用：管理员登录 `/admin` 后，在自己的卡片中注册至少两个 Passkey，再按需切换为“仅 Passkey 登录”；切换后该账号的密码登录会被禁用，但仍保留受保护的密码摘要以便必要时恢复。`/admin` 可以设置每个模块的查看名单：名单直接匹配 SSO 解析出的金蝶用户名，多个用户可以逐行填写或用逗号分隔；普通模块名单留空表示所有已登录员工可见，有名单时仅名单人员和超级管理员可见。权限同时作用于页面目录和服务端查询接口，不能通过直接请求绕过。管理员点击“退出管理员，使用 SSO”后会清除本地管理员会话并返回查询台，由 SSO 身份接管。

只返回本人数据的费用报销和审批进度模块默认向所有已登录用户开放，管理员仍可通过名单进一步限制入口。人员成本属于敏感模块，名单为空时仅超级管理员可见；加入名单后，也只有名单人员和超级管理员可见。查询台按模块分别保存当前页面会话内的查询结果；切换到未查询模块时不显示其他模块的数据，切回后恢复该模块上一次的结果和排序。

首次部署需要在数据目录中创建第一个超级管理员。不要把初始密码写进 `.env`、源码或 Git；创建完成后，权限文件只包含随机盐和密码摘要。后续管理员可直接在 `/admin` 中维护其他超级管理员。

仓库提供 Nginx Proxy Manager 模板。把部署地址保存在 `.env` 后生成可粘贴的配置：

```bash
set -a
. ./.env
set +a
envsubst '${AUTHELIA_URL} ${APP_UPSTREAM} ${AUTH_TRUSTED_PROXY_TOKEN}' \
  < deploy/npm-advanced.conf.template \
  > deploy/npm-advanced.generated.conf
```

生成文件已被 Git 忽略。

## 金蝶配置

各查询模块的业务用途、筛选条件、结果字段、权限边界和已知限制见 [`docs/modules/`](docs/modules/README.md)。文档只使用脱敏说明，不保存生产账号、密钥或真实业务数据。

服务使用：

```text
Kingdee.BOS.WebApi.ServicesStub.AuthService.LoginByAppSecret
Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteBillQuery
```

请在金蝶中启用 WebAPI 权限控制，并为相关用户配置业务对象、组织和数据权限。不同版本或二开账套的字段标识可能不同，部署前应在 BOS 或 WebAPI 测试页面核对 [`config/query-catalog.json`](config/query-catalog.json)。

默认白名单包括：

- `inventory`：即时库存
- `inventory_cycle`：按“收料入库 → 公司仓/项目仓调拨 → 客户签收”核算公司仓、项目仓、客户仓物料的库存周期和客户仓待签收天数；项目仓和客户仓必须关联项目
- `sales_orders`：销售订单
- `sales_business_analysis`：销售子项目经营分析；以销售子项目单据的“预计毛利率(不含税)(%)”和“预计毛利(不含税)”为主数据，串联合同、销售订单、出库交付、销售发票、应收单、收款单和退款单；结果按销售子项目汇总，预计毛利率不会直接相加，汇总卡片按合同不含税金额加权；该模块默认受限，需管理员配置查看名单
- `overdue_receivables`：发票账龄，按销售子项目汇总已开票且超过指定天数仍未结清的应收，默认超过 180 天；输出销售子项目编码、名称和开票日期
- `receivable_aging`：按应收单日期汇总已形成应收且超过指定天数仍有未收款余额的销售子项目；应收未开票金额作为独立辅助维度展示
- `overdue_risk_combined`：按照发票超期和应收超期的设定天数，取二者查询结果的最大值
- `purchase_orders`：采购订单
- `supplier_purchase_analysis`：按供应商汇总采购订单、到货、入库、退料、交付、应付、采购发票、付款、供应商主数据画像和可用质量指标；默认当年，最多 366 天；采购金额属于受限模块，需管理员配置查看名单
- `expense_claims`：本人费用报销单
- `workflow_progress`：我发起且正在审批的流程、当前节点和当前处理人；使用金蝶标准只读对象 `WF_ProcInstBill`

网页每次最多展示 100 条结果。销售和采购订单只返回业务可读字段，不展示金蝶内部主键；销售订单也不展示客户编码。

如需增加其他业务对象，请在查询目录中明确登记表单、返回字段、允许的筛选条件和必要的用户范围限制。不要开放调用方直接传 SQL 或金蝶过滤表达式。

## Dify

OpenAPI Schema 位于：

```text
GET /openapi.json
```

Dify 调用示例：

```bash
curl -X POST https://query.example.com/api/dify/v1/query \
  -H 'Authorization: Bearer <DIFY_API_KEY>' \
  -H 'X-End-User: 240001' \
  -H 'Content-Type: application/json' \
  -d '{"query":"查询物料编码 A100 的库存"}'
```

也可以在请求体中传递 `user`。Dify 应透传能够登录金蝶且与业务人员映射一致的最终用户标识，不要使用所有请求共用的管理员身份。

## Docker

```bash
docker compose up -d --build
curl http://127.0.0.1:8092/healthz
```

容器以非 root 用户运行，审计日志默认写入 `data/audit.ndjson`。该目录已被 Git 忽略。

审计日志记录 SSO/管理员登录、退出、查询模块、查询条件、结果数量、成功或失败、耗时、来源 IP 和浏览器标识，不记录密码、密钥或查询结果明细。超级管理员可在 `/admin` 的“操作日志”区域查看最近 500 条记录。日志达到 `AUDIT_MAX_BYTES` 后自动轮转，并按 `AUDIT_MAX_FILES` 控制保留数量。

Compose 默认使用 `172.16.240.0/24`，避免 Docker 自动从 `192.168.0.0/16` 分配网络而与企业内网冲突。若该网段在你的环境中已被使用，请在 `.env` 中把 `DOCKER_SUBNET` 改为经过网络管理员确认的空闲私有网段；不要使用与公司路由重叠的地址段。

服务器无法访问 npm registry、但已经缓存 `node:20` 镜像时，可以使用 `Dockerfile.offline`。离线构建会复制本机安装好的 `node_modules`，部署包中不要包含 `.env` 或业务数据。

## 审批进度

查询台直接调用金蝶标准 `ExecuteBillQuery`，读取只读流程对象 `WF_ProcInstBill`。服务端固定按当前登录账号和“审批中”状态过滤，页面不能提交发起人、状态、表单对象或任意过滤表达式。

“我发起的流程”页签显示单据编号、流程名称、当前节点、当前处理人、节点到达时间和发起时间。该方案不安装 DLL，也不需要在金蝶云服务器部署自定义组件；使用现有 WebAPI 应用授权即可。

## 安全边界

- 本项目是业务对象查询层，不是数据库查询代理
- 不接受任意 SQL、`FormId`、`FieldKeys` 或 `FilterString`
- Dify Key 只验证调用方，最终用户仍必须单独透传
- 金蝶应用密钥、SSO 共享密钥、Dify Key 和 AI Key 只保存在 `.env`
- 审计日志、数据库导出、用户权限清单和业务 Excel 不应提交到 Git
- 公开仓库不能替代部署侧的网络隔离、最小权限和密钥轮换
