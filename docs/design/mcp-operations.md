# Query Hub MCP 实施和运行说明

Query Hub 提供 13 个模块、15 个只读工具。中心按模块开通，员工继续使用原来的承希 AI 连接器地址。首次上线保持关闭；只有完成身份映射、目录审核与灰度验证后才开放给员工。

## 增加模块

在查询目录中登记业务数据源与参数，补上 `mcp.grain`（结果粒度），并按需要配置 `mcp.inputSchema` 和 `mcp.version`。标准查询复用查询引擎；复杂查询先实现其业务逻辑。模块若暂不对 MCP 发布，设置 `mcp.enabled: false`。修改统计口径、返回字段或处理逻辑时递增契约版本，即使输入参数保持不变也要递增。

中心从目录凭证的分页 `tools/list` 读取定义以及 `_meta["chency/capability"]`（模块、只读 scope、敏感级别、粒度及定义摘要），整体保存为待审核快照。这个实现将发现和权限映射放在同一份快照，`/internal/mcp/v1/manifest` 提供等价清单用于排查。配置目录凭证后中心启动时和每十五分钟同步，也可在管理端立即检查。新工具经管理员审核后可开通；已授权员工不会自动获得新模块。新版本待审时旧客户端不能使用过期定义调用。下架工具在业务端立即失效。

## 开通前配置

1. 准备内网 TLS 证书，证书 SAN 与 `queryhub-mcp-internal` 或实际配置的服务主机名一致。中心和 Query Hub 各自信任对端证书的 CA。
2. 在部署机建立仓库之外的私有目录，放置 `server.crt`、`server.key`、`ca.crt` 和 `identities.json`；限制读取权限，并确保容器 Node 用户可读。使用 [Compose 扩展](../../deploy/docker-compose.mcp.yml) 连接中心使用的内部网络，8093 端口不映射至宿主机。
3. 由管理员核对中心稳定员工标识、业务账号和唯一金蝶用户名。禁止仅按中文姓名匹配。用部署机上的私有映射文件维护；在同目录生成新文件后以原子替换更新，下次请求立即读取。仅允许唯一员工标识与唯一金蝶账号，不使用管理员或共享账号回退。示例为虚构值：

   ```json
   [{"subject":"directory-id-example","username":"example.employee","kingdeeUsername":"example-kingdee-user"}]
   ```

4. 在两端设置三把不同的随机密钥（至少 32 字符），仅保存于部署机：

   | 方向 | Query Hub | MCP 中心 |
   | --- | --- | --- |
   | 中心发现目录 | `MCP_DIRECTORY_TOKEN` | `QUERYHUB_DIRECTORY_TOKEN` |
   | 中心转发员工调用 | `MCP_SERVICE_TOKEN` | `QUERYHUB_SERVICE_TOKEN` |
   | Query Hub 回查委托权限 | `MCP_CENTER_SERVICE_TOKEN` | `QUERYHUB_CONTEXT_TOKEN` |

5. Query Hub 设置 `MCP_CENTER_INTERNAL_URL` 指向中心内部 HTTPS 服务。中心的 `QUERYHUB_MCP_URL` 指向 Query Hub 内部 HTTPS MCP 入口（默认为 `https://queryhub-mcp-internal:8093/api/mcp/`）。启动时对 Query Hub 开启 `MCP_ENABLED=true`；中心服务卡仍默认关闭。
6. 中心管理端检查连接并审核待发布目录，先将“金蝶查询”的申请权限限制到已核对映射的灰度员工，再上线卡片。员工勾选模块后使用已有凭证刷新工具列表。

中心的系统申请资格、员工模块开通、Query Hub 模块名单和金蝶数据权限都必须满足。中心卡片上的模块选项是可开通的目录；员工客户端实际看到的 MCP 工具还需通过 Query Hub 的实时权限检查。权限撤销后可直接用旧客户端重试，验证服务端拒绝。

## 验证和关闭

用两个权限不同的测试员工验证工具可见性、报销本人范围和敏感模块，再用相同查询条件比较网页与 MCP 结果。核对中心调用记录和 Query Hub 审计的模块、来源和结果。不在文档、测试或仓库中保存实际员工映射、凭证和业务明细。

快速关闭：中心关闭“金蝶查询”卡片，撤回后续调用；必要时将 Query Hub 的 `MCP_ENABLED` 设为 `false` 并重建服务。网页和 Dify 继续使用原有入口。运行结果按现有金蝶读取上限处理；完整性无法证实时返回未知，不能将显示行数当成全部业务记录。
