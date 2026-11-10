# 连接器（平台能力供给）

> 本文件是 `develop-ai-agent` skill 的组成部分。`sql` / `redis` / `lark-cli` 已有，
> `http` / `mcp` 待补（有真实客户再做）。
> 旧设计稿 [`docs/design/ai-connector.md`](../../../../docs/design/ai-connector.md) 已归档，以本文件为准。

## 0. 一句话

**连接器 = 一条后台能配的数据：地址 + 凭证 + 启停 + 状态，产出一组受管工具。**
它是 AI 平台层的**能力供给侧**，agent 是消费侧，中间用「工具授权」解耦。

三条边界：

- **只管外部系统**（客户的库、三方 API、三方 MCP）。产品自己的库 / 缓存走业务工具，
  别用连接器开旁路——那会绕过权限、业务规则与审计；
- **MCP 是连接器的一种驱动**，不是另一个概念（三方服务给的 MCP 地址，就是一条连接器实例）；
- **凭证只存在实例上**，不落 `ai_tools`，不进对话。

## 1. 驱动与能力投影

| 驱动 | 实例里配什么 | 产出什么工具 | 状态 |
| --- | --- | --- | --- |
| `sql` | host / port / 库 / 只读账号 | `list-tables` / `describe-table` / `query` | 已有 |
| `redis` | 地址 / 密码 / 键前缀 | `scan-keys` / `get` / `hgetall` | 已有 |
| `http` | baseURL + **声明的端点**（method / path / 参数 schema / 凭证注入） | 每个端点一个工具 | 待补 |
| `mcp` | MCP 地址 + 认证头 | 远端 `tools/list` 动态发现 | 待补 |
| `lark-cli` | App ID / Secret | 一个受限 `run`（CLI 内嵌 20+ 业务域技能文档） | 已有 |

`http` 的关键是**端点即数据**：模型只能调声明过的端点，不能传任意 URL —— 同时解决 SSRF 与凭证泄露。
`mcp` 的远端工具名要保留原名（`remote_tool_name`），工具 key 只当可读约定，不做反解。

## 2. 治理（新驱动必须一起做，不能"先通再补"）

- **只读默认**：写操作（POST/PUT）要显式声明，并在调用前让用户确认；
- **端点约束**：`http` 只调声明过的端点；`mcp` 只连管理员配的地址；
- **出参不可信**：远端描述与返回都是提示词注入入口 —— 限大小、分页、按数据对待；
- **限额与审计**：沿用网关的 rate limit / 审计；出参脱敏沿用 `redact`；
- **作用域**：实例产出的工具默认 `scope='admin'`；给产品 agent 用要改成 `agent` + `allowedAgents`。

## 2.1 授权状态：无状态 pod 怎么保住 CLI 的 token

lark-cli 把 app 配置与用户 token 存在 HOME 里；pod 无状态、不挂 PVC。所以：

- 状态存 `ai_connectors.auth_state`（jsonb：`{ 相对路径: base64 }`）+ `auth_state_version`；
- 每次调用前 `hydrate`：版本不同就把库里的文件恢复到临时 HOME（`/tmp`）；
- 调用后 `persist`：diff HOME，变了就带版本号 CAS 写回；
- 同一连接器的调用用 Redis 锁串行化（`connector:lark:<id>`）：token 是 CLI 在命令内部刷新的，
  只能锁整个调用，避免两个 pod 互相覆盖；
- 授权本身走 CLI：`auth login --no-wait --json` 拿链接 → 用户完成后 `--device-code` 收尾；
  系统级共享一份授权（不是每个用户一份）。
- 删除连接器时 `dispose` 清库 + 删 HOME，token 不留。

## 3. 与 agent 的接线

```ts
// 某个 agent 想用这个连接器的全部工具
tools: [{ connector: 'prod-pg' }]
// 只要一个
tools: [{ connector: 'prod-pg', tool: 'query' }]
```

- 授权清单写选择器（见 [define-agent.md](./define-agent.md)），装配期展开成具体 key；
- **每个 agent 分别授权**：同一个连接器的工具可以只给运营 agent，不给客服 agent；
- 工具面别一次挂太多：10 个连接器 × 20 个工具会让模型选择困难，按 agent 裁剪。

## 4. 验收

- [ ] 实例保存 / 同步后 `ai_tools` 里出现对应工具（`origin='connector'`、`remote_tool_name` 保留）；
- [ ] 停用 / 删除实例 → 工具从注册机摘掉，agent 工具面同步消失；
- [ ] 前台用户身份调用 admin 作用域的工具：**装配期就看不到**（不是调了才拒）；
- [ ] 写操作未声明时不可调用；声明后调用前有确认；
- [ ] 出参超限会分页，`read-tool-result` 能取回后续页；
- [ ] lark-cli：授权后重启 pod / 换一个实例，`doctor` 仍显示身份可用（说明 auth_state 生效）。
