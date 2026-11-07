# AI 连接器：从「代码里写工具」到「后台接入外部服务」

> 状态：设计稿（2026-10-27），未实施。
> 相关：`ai-agent-tool-engine.md`（工具引擎）、`ai-agent.md`（运行时与装配）。
> 本文所有现状描述以仓库当前代码为准，引用处标了文件。

---

## 1. 背景

### 1.1 现在加一个外部能力要做什么

工具只有**一个来源**：代码里的工具组。

```
@ToolGroup 类（apps/server/src/modules/ai/tools/*.tool.ts）
  → @ToolDecl 方法（一个方法一个工具）
  → AGENT_TOOL_GROUPS 登记一行（tools.types.ts:379）
  → ToolRegistry 构造期 buildToolSpecs() 拍平成 key → 工具表（core/tools/tool.registry.ts:63）
  → ToolSeedService 启动时把声明同步进 ai_tools（tool.seed.service.ts）
  → createAgentDefinitions() 用 registry.describe() 渲染提示词（agents/index.ts:69）
  → createMastra() 在 bootstrap 期把 agent 实例建好（ai.module.ts:208 / mastra/ai.mastra.ts）
```

也就是说：**接一个外部服务 = 改代码 + 重启 + 重新审一遍权限与限额**。这对「开箱即用的基座」是硬伤——用户拿到模板第一件事就是想接自己的飞书 / 邮箱 / 内部系统。

### 1.2 连接器要解决什么

把「外部服务」变成**数据**：

- 后台加一条连接器记录 → 同步出它的工具清单 → 这些工具自动进入注册机、走同一套网关（开关 / 作用域 / 限额 / 脱敏 / 审计 / 分页）；
- 加第二家服务不需要改代码；
- 关掉一个连接器，它的工具立刻不可调（而不是等到下次发版）。

一句话：**工具来源从一份（代码）变成两份（代码 + 连接器），治理流程只有一套。**

### 1.3 和 WorkBuddy 那类产品的差别

WorkBuddy 的连接器 = MCP 能力 + 授权托管 + 启停外壳，内置 QQ 邮箱 / 腾讯文档 / TAPD 这类厂商卡位。

Billy 是基座，内置连接器的价值不在「接了多少家」，而在**每种接入方式都有一份能跑、能照抄的样板**。所以本文把「接入模式」当第一等公民，把厂商当样板。

---

## 2. 范围

### 2.1 本期做

| 项 | 内容 |
| --- | --- |
| 连接器实例 | 一条记录 = 一个外部服务（可多条，同一驱动可接多次） |
| 驱动（driver） | 内置驱动若干；驱动声明「配置长什么样、怎么列工具、怎么调工具、怎么探活」 |
| 传输 | MCP over stdio（子进程）、MCP over HTTP（streamable）；另有一个「单动作」驱动给 webhook 用 |
| 工具接入 | 连接器工具进注册机，与代码工具同权：网关、后台页、审计、分页、脱敏 |
| 后台 | `/main/ai/connectors`：列表、新建、编辑、测试连接、同步工具、启停 |
| 凭证 | 管理员级、全局一份（沿用 `ai_connectors.secrets` 明文口径，见 §8） |

### 2.2 本期不做

- **不做按用户授权**（每个前台用户各自授权自己的飞书）。这一维会牵动权限链、凭证表、脱敏、审计四层，放二期（§12.2），一期只做管理员全局。
- **不开放自定义 stdio 连接器**。命令 + 参数让管理员填 = 任意命令执行（§8.1），只有内置驱动能声明命令。
- 不做连接器市场、不做远程托管、不做按工具的独立授权策略（工具授权仍按 agent 声明 + `scope` 两层）。
- 不做连接器工具的自定义事件（`ctx.emit`）；工具事件仍只有代码工具会发。

---

## 3. 术语

| 词 | 意思 |
| --- | --- |
| 连接器实例 | `ai_connectors` 的一行。一个具体的服务端点（含地址与凭证） |
| 驱动 | 代码里的一个实现，决定这种连接器怎么配、怎么发现工具、怎么调。类似工具里的「工具组」 |
| 远端工具 | 连接器那边暴露的一个操作（MCP 的 `tools/list` 条目），还不是我们的工具 |
| 连接器工具 | 把远端工具包成 `ToolSpec` 之后的结果：有稳定的 key、进注册机、走网关 |
| 同步 | 连接 → 列工具 → upsert 进 `ai_tools` → 注册进注册机 → 重建 agent 定义 |

---

## 4. 总体结构

```
                    ┌─────────────────────────────────────────┐
  代码工具组 ────────► ToolRegistry（注册机，两段来源）           │
                    │   静态段：AGENT_TOOL_GROUPS             │
  连接器同步 ────────►   动态段：connector → ToolSpec[]          │
                    └───────────────┬─────────────────────────┘
                                    │ describe() / toolbox()
                    ┌───────────────▼─────────────────────────┐
                    │ AgentCatalog：定义 + Mastra 实例（可重建）│
                    └───────────────┬─────────────────────────┘
                                    │ 每轮 run 取当前快照
                                    ▼
                              工具网关（插件链不变）
```

三条设计要点：

1. **注册机是唯一的工具出口**，连接器不自建调用路径。工具被调用的那一秒，网关照样跑 `enabled → scope → rate-limit → validate → exec → redact → paginate → audit`（`core/tools/plugins/`）。
2. **`ai_tools` 复用，不另建表**。开关、作用域、限额、密钥提示、审计全按 `tool_key` 走；换一张表就要再实现一套治理。
3. **装配要可变**。现在 `createAgentDefinitions()` 与 `createMastra()` 都在 bootstrap 跑一次（`ai.module.ts:195-240`），提示词里的工具清单是那时拍的快照。连接器工具是运行期出现的，所以要把「定义 + 实例」从一次性工厂改成 `AgentCatalog` 持有的当前快照，支持原子重建。**这是本期改动面最大的一处**（§7.3）。

---

## 5. 数据结构

### 5.1 新表 `ai_connectors`

实体：`apps/server/src/database/entities/ai-connector-entity.ts`（继承 `AuditEntity`）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `key` | varchar(32) | 实例标识，`[a-z0-9-]`，软删感知唯一（照 `ai_tools` 的 `uk_tool_key` 写法） |
| `name` | varchar(64) | 显示名 |
| `driver` | varchar(32) | 驱动标识，如 `mcp-stdio` / `mcp-http` / `webhook` |
| `kind` | varchar(16) | `builtin`（内置） / `custom`（管理员自建） |
| `transport` | varchar(16) | `stdio` / `http` / `none`（由驱动的声明写死，冗余列供页面筛选） |
| `config` | jsonb | 驱动专属配置（URL / 命令占位 / 请求头 / 超时）；**不含密钥** |
| `secrets` | jsonb | 密钥明文（沿用 `ai_tools.secrets` 的口径，见 §8.3）；接口只回提示串 |
| `enabled` | boolean | 总开关；关掉后它的工具全部不可调 |
| `status` | varchar(16) | `unknown` / `ok` / `error`（页面用） |
| `last_error` | text | 最近一次失败的原文（脱敏后） |
| `last_checked_at` | timestamptz | 最近一次探活 / 同步时间 |
| `tool_count` | int | 上次同步到的工具数（页面用，避免每次去 count `ai_tools`） |

### 5.2 `ai_tools` 加三列

实体 `ai-tool-entity.ts` 追加：

| 列 | 默认 | 说明 |
| --- | --- | --- |
| `origin` | `'code'` | 来源：`code` / `connector`。存量行自动是 `code` |
| `connector_id` | null | 指向 `ai_connectors.id`（不加外键，遵守仓库现有口径） |
| `remote_tool_name` | varchar(128) null | 远端原始工具名；调用时回传它，key 变了不影响调用 |

为什么不复用 `source` 列：`source` 表达的是**配置来路**（`seed` 代码声明 / `manual` 人工改过），「工具从哪来」是另一条轴。两件事塞一列，种子同步的判定会立刻变复杂。

### 5.3 字典（`packages/shared/src/dicts/ai-tool.dict.ts`、新增 `ai-connector.dict.ts`）

- `ToolCategory` 加一项：`Connector`（`'connector'`，标签「外部连接器」）——只用于后台筛选与展示。
- 新增 `ConnectorKind`（`builtin` / `custom`）、`ConnectorStatus`（`unknown` / `ok` / `error`）。
- `ToolDenyReason` 加 `Upstream`（`'upstream'`，标签「外部服务不可用」）——连接器连不上/超时/协议错时用它。理由：`internal` 的语义是「我们自己写错了」，混用会让排障、告警、模型提示全部说两套话。
- `ToolSource` **不动**。

### 5.4 迁移

`apps/server/src/database/migrations/<ts>-AiConnector.ts`：

1. 建 `ai_connectors`；
2. `ai_tools` 加 `origin`（默认 `'code'`，`NOT NULL`）、`connector_id`、`remote_tool_name`；
3. 索引：`uk_connector_key`（软删感知唯一）、`idx_connector_enabled`、`idx_tool_connector`（`connector_id`）。

---

## 6. 驱动抽象

### 6.1 接口

文件：`apps/server/src/modules/ai/core/connectors/connector.driver.ts`（主体，**不 import `@mastra/*`**，由 `pnpm check:mastra` 守）

```ts
/** 远端工具的描述（纯数据：还没有 key，也还没有 ToolSpec） */
export interface RemoteToolDesc {
  /** 远端原始名，调用时必须原样回传 */
  readonly name: string
  readonly title: string | null
  readonly description: string | null
  /** MCP 的 inputSchema（JSON Schema）；缺失时按"任意对象"处理 */
  readonly inputSchema: Record<string, unknown> | null
}

/** 一次连接器操作要用到的全部输入 */
export interface ConnectorRuntime {
  readonly key: string                       // 实例 key（工具 key 前缀、日志、审计都用它）
  readonly config: Record<string, unknown>
  readonly secrets: Record<string, string>   // 只在这一次操作内使用，禁止落库 / 进日志
  readonly signal?: AbortSignal
}

export interface ConnectorDriver {
  readonly kind: string
  readonly transport: 'stdio' | 'http' | 'none'
  /** 驱动专属配置：每个字段都要有默认值（与工具 `config.parse({})` 同一条约定） */
  readonly config: z.ZodType<Record<string, unknown>>
  /** 密钥字段元信息（页面渲染 + 缺配置时的结论文案 + 出参脱敏） */
  readonly secrets: readonly ToolSecretField[]
  /** 列工具（一次连接内可列多次，实现自己决定要不要缓存） */
  listTools(rt: ConnectorRuntime): Promise<RemoteToolDesc[]>
  /** 调一个工具；抛错由上层翻成 `upstream` 结论 */
  callTool(rt: ConnectorRuntime, name: string, args: unknown): Promise<unknown>
  /** 探活（后台「测试连接」按钮，也是健康检查） */
  probe(rt: ConnectorRuntime): Promise<{ ok: boolean; message?: string }>
  /** 释放常驻资源（stdio 子进程） */
  dispose?(key: string): Promise<void>
}
```

驱动登记机：`CONNECTOR_DRIVERS` 注入数组（照 `AGENT_TOOL_GROUPS` 的写法），`ConnectorDriverRegistry` 按 `kind` 索引，启动期校验 kind 唯一、`config.parse({})` 成功、内置驱动的命令模板合法——与工具注册机同样「声明不全就启动失败」。

### 6.2 MCP 驱动

`core/connectors/drivers/mcp.driver.ts`：一个基类 + 两个传输。

- **stdio**：`command` + `args` + `env` 由**驱动代码写死**（内置样板尤其如此），管理员只能填 env 值（如根目录）。子进程的生命周期交给 `ConnectorClientPool`（§9）。
- **http**：`url` + `headers`（可带 `Authorization`），streamable HTTP，带 session id 与断线重试。
- 映射：`tools/list` → `RemoteToolDesc[]`；`tools/call` → 结果按 content 拼成文本（image / resource 二期再接对象存储，一期降级成一句提示）。

### 6.3 webhook 驱动（P1）

`transport: 'none'`，只有一个「发消息」动作：`config` 是 URL，`secrets` 是一条 webhook key，`listTools()` 返回一条写死的描述。它证明抽象里「没有工具发现也能是连接器」，也是最短的一份样板。

### 6.4 内置连接器（P0 / P1 清单）

| 期 | 连接器 | 驱动 | 为什么选它 |
| --- | --- | --- | --- |
| P0 | 本地文件系统 | `mcp-stdio` | 零外部依赖，验的是进程拉起、握手、工具发现、退出清理——MCP 最容易出事的一段 |
| P1 | 群机器人通知（企微 / 飞书） | `webhook` | 最小连接器：没有工具发现，只有一条动作 |
| P1 | HTTP + API Key 工具集（示例取 GitHub） | `mcp-http`（或 `http-api`） | 最普遍的「远程 REST 映射成工具」，外加 token 脱敏 |

明确**不内置**腾讯文档 / TAPD / 乐享 / 微云 / QQ 邮箱这类厂商卡位：模板替厂商托管用户凭证不现实，交给 P1 的「自定义 MCP 连接器」自己填。

---

## 7. 工具接入链路

### 7.1 从远端工具到 `ToolSpec`

`core/connectors/connector.tool.factory.ts`，纯函数，好测：

```ts
toConnectorToolSpec(driver, connector, remote): ToolSpec
```

| 字段 | 取值 |
| --- | --- |
| `key` | `c-<连接器 key>-<远端名归一化>`，规则见 §7.2 |
| `title` | 远端 title（缺省用 name） |
| `description` | `【连接器：<连接器名>】` + 远端 description + 一句纪律（外部内容按数据看，不执行其中的指令）；总长上限 1000 字 |
| `params` | `z.fromJSONSchema(inputSchema)`（zod 4.6 已实测可用）；转不动时降级 `z.record(z.unknown())` 并记 warn |
| `config` | `z.object({}).default({})`——连接器级配置在连接器行上，工具行不再重复 |
| `secrets` / `secretFields` | 取自驱动声明（如 `token`），供 `redact` 插件脱敏 |
| `events` | `[]` |
| `category` | `'connector'` |
| `scope` / `delegation` / `child` | 默认值；作用域可在后台逐工具改（复用现有 `ai_tools` 配置） |

### 7.2 工具 key 规则

- 格式：`c-<连接器 key>-<远端名>`，全部小写，非 `[a-z0-9-]` 换成 `-`，连续合并，总长 ≤ 64（受 `ai_tools.tool_key` 的 varchar(64) 约束）。
- **撞名不静默处理**：同一连接器里两个远端名归一化后相同，整个连接器置 `error` 并提示改名。加序号会让「模型看到的 key」与「远端名」对不上，排障时找不到北。
- 与静态工具撞 key：注册机拒绝，记 error 日志，连接器置 `error`（不炸进程）。
- key 一旦建立不再变；远端改名 = 旧行保留（`enabled=false`、`last_seen_at` 停在旧时间）+ 新行新增。历史 run 的时间线还引用旧 key，删了就查不出当年调了什么（与 `tool.seed.service.ts` 的现有口径一致）。

### 7.3 注册机与装配（主要矛盾）

**注册机**（`tool.registry.ts`）改两处：

1. `byKey` 分两段：`static`（构造期，现有逻辑）与 `dynamic`（运行期）。`specs()` 合并返回，但新增 `staticSpecs()` 只给种子同步用——否则 `ToolSeedService` 会把连接器工具当成「代码声明的镜像」反复覆盖。
2. 新增 `registerDynamic(connectorId, specs[])` / `removeDynamic(connectorId)` / `onChange(listener)`。冲突、重名一律拒绝并记日志，不抛到进程外。

**装配**（`ai.module.ts` 的 `AGENT_REGISTRY` 与 `MASTRA` 两个工厂）改成 `AgentCatalog` 服务：

```ts
class AgentCatalog {
  current: { definitions: readonly AgentDefinition[]; mastra: Mastra }
  async rebuild(reason: string): Promise<void>   // 串行、去抖、失败保留旧实例
}
```

- `rebuild()` 重跑 `createAgentDefinitions()`（提示词里的工具清单随之更新），再 `createMastra()`，**原子换引用**；
- 消费方（`runtime/chat.service.ts`、`runtime/agent-runner.ts`）每轮从 `catalog.current` 取，**在途 run 持有旧引用**——与现在「工具面是装配期快照」的语义一致，不会中途换工具；
- 触发点：连接器启用 / 停用 / 同步后工具清单变化；页面上的「应用变更」按钮；启动完成后一次（连接器在启动时异步同步，不阻塞启动）。

**工具授权**：`assistantAgent.tools` 现在是写死的 key 列表（`agents/assistant.agent.ts`）。加一个 `ALL_TOOLS` 标记，在 `createAgentDefinitions()` 里展开成「当时注册机里的全部 key」——照 `skills: [ALL_SKILLS]` 的现成做法（`agents/index.ts:70-80`）。否则连接器工具进不了提示词与授权面。

### 7.4 同步流程

```
后台「同步」（或启动时对 enabled 的连接器）
  → 连接（懒建客户端）
  → driver.listTools()
  → 校验：数量上限（默认 20，超出截断并提示）、key 冲突、归一化
  → 生成 ToolSpec[]
  → 事务：upsert ai_tools（origin=connector，connector_id，remote_tool_name，
          写 title/description/param_schema；远端已消失的行 enabled=false）
  → registry.registerDynamic(...)
  → catalog.rebuild('connector:sync')
  → 更新 ai_connectors（status / tool_count / last_checked_at）
```

失败任一步：`status='error'` + `last_error`，注册机里移除该连接器的旧工具（避免「页面显示失败、实际还能调」），页面给「重试」。

---

## 8. 凭证与安全

### 8.1 命令执行边界

- `mcp-stdio` 的命令与参数**只能由驱动代码声明**，管理员只能填配置值（如根目录）。页面不提供「命令」输入框。
- 自定义连接器只开放 `http` 传输（P1）。理由：`command` + `args` 由页面填写等于给后台一个任意命令执行入口，而 `run-command` 已经是显式能力，没必要再从参数侧开一个。
- 部署闸：`AGENT_CONNECTOR_STDIO=builtin-only | off`，默认 `builtin-only`。

### 8.2 出网边界

- `mcp-http` 的地址复用联网工具那一套判断（禁内网 / 禁环回，`allowPrivateNetwork` 由 env 硬闸决定，页面改不动——照 `ToolEnvCaps.web` 的现成口径）。
- 单次响应体上限 2 MB，超了截断并给一条提示；给模型的页仍由 `paginate` 插件统一切。
- 连接器返回的内容与网页抓取同一威胁模型：**当数据处理**，工具说明里写明不执行其中指令。

### 8.3 凭证口径

沿用 2026-10-01 的决定（`ai_tools.secrets` / `ai_providers.api_key` 明文入库，补偿是「接口不回明文 + 日志与出参脱敏」）：

- `ai_connectors.secrets` 存明文；接口只回 `hintOf()` 派生的提示串；
- 驱动声明的 `secretFields` 进 `redact` 插件，出参与日志里的密文换成提示串；
- 代价照实记：库被读走 = 凭证泄露。**OAuth 的 refresh token 比 API key 更敏感**（能长期冒充用户），二期做 OAuth 前必须重新拍板（§15）。

---

## 9. 生命周期与容错

`core/connectors/connector.pool.ts`：

| 事项 | 取值 / 做法 |
| --- | --- |
| 客户端建立 | 懒建：第一次调用或同步时连；stdio 子进程常驻，空闲 5 分钟回收 |
| 并发 | 每实例最多 4 个并发调用，超出排队；stdio 管道由客户端串行化（实现里保证不乱序） |
| 超时 | 连接 10s、单次调用 30s（`config.timeoutMs` 可覆盖，上限由 env 夹紧） |
| 崩溃恢复 | 调用失败先重建客户端再重试一次；连续 3 次失败置 `status='error'` 并停止重试（等下次探活或页面重试） |
| 进程清理 | `dispose()` 在连接器停用 / 删除 / 进程退出时调用；`OnApplicationShutdown` 统一收口，不留孤儿进程 |
| 健康检查 | 页面「测试连接」调 `probe()`；不自动轮询（一期），避免给外部服务加无谓流量 |

### 9.1 本地 MCP 进程的状态管理（stdio 传输）

stdio 连接器是**服务进程的子进程**，状态有两份，必须分清：

| | 真相在哪 | 谁写 | 页面怎么用 |
| --- | --- | --- | --- |
| **进程状态** | 内存（`ConnectorPool` 的 `Map`） | 启动 / 退出 / 崩溃时 | 不直接展示，只映射成一个结论 |
| **连接器状态** | `ai_connectors.status` 等列 | 状态迁移时写一次（不是每次调用） | 列表与详情的「状态」列 |

关键一句：**库里的 `status` 是「上次看到的结论」，不是「现在」。** 上一代服务进程被杀之后，库里还写着 `ok`，子进程早就没了。所以启动时先对账一次：`UPDATE ai_connectors SET status='unknown' WHERE enabled`，让页面回到「未验证」，而不是继续显示一个假的绿点。

#### 状态机

```
idle ──start()──► starting ──initialize + tools/list 成功──► ready ──空闲 5 分钟──► closing ──► stopped
                    │                                          │
                    └──spawn 失败 / 握手超时──┐                 └──子进程退出 / 调用失败──┐
                                              ▼                                            ▼
                                           crashed ◄────────────────────────────────────┘
```

| 状态 | 含义 | 进入条件 | 写进库里的结论 |
| --- | --- | --- | --- |
| `idle` | 没拉起（懒启动，或回收之后） | 刚启动 / 回收完成 / 停用 | 保持上次结论；停用用 `enabled=false` 表达 |
| `starting` | 进程已 spawn，协议还没握手完 | `start()` | `unknown`（进行中，不覆盖已有错误） |
| `ready` | `initialize` + `tools/list` 都成功 | 握手完成 | `ok` |
| `closing` | 已发 SIGTERM，等在途调用收尾 | 空闲回收 / 停用 / 删除 / 进程退出 | 不动 |
| `stopped` | 子进程正常退出（退出码 0） | 收到 exit | `unknown` |
| `crashed` | 非正常退出：非 0 退出码、被信号杀、握手超时、重建失败 | 以上任一 | `error` + `last_error` |

「忙」不单列状态：`ready` + `inflight>0` 就够（`inflight` 是并发计数，模型看到的工具清单与页面都只看状态本身）。

#### 六个容易踩的地方

1. **stderr 必须持续读**。没人读的话，管道缓冲区（默认 64KB）写满后子进程会阻塞，外部表现是「调用卡死、没有任何日志」。做法：常读，只留最近 50 行环形缓冲，出错时附进 `last_error`（脱敏后）。
2. **stdout 只认协议**。本地 MCP server 常常往 stdout 打一行自己的启动信息（如 `Server started`），不能让「解析失败」直接判死：非 JSON-RPC 的行记 warn 后丢弃，连续多行无法解析才升级为 `crashed`。
3. **杀进程要杀进程组，不是单个 pid**。`npx some-mcp` 这种还会再起一个真身进程，只杀父进程会留下孙子。POSIX 用 `spawn(..., { detached: true })` 起独立进程组、关闭时 `kill(-pid, 'SIGTERM')`；Windows 用 `taskkill /PID <pid> /T /F`。先软后硬：SIGTERM → 等 3s → SIGKILL。
4. **孤儿要兜底，不能指望 `pnpm kill:dev`**。`node --watch` 重启（`apps/server/package.json` 的 `dev`）与被 `kill -9` 都会让子进程被 reparent 到 init：它既不是 dev 进程的子孙、也不监听端口，`scripts/kill-dev.ts` 的两条判定都命中不了。兜底：
   - 拉起时写 `data/mcp-pids.json`（`{connectorKey, pid, startedAt, serverPid}`），正常退出时删；
   - 启动时读它：`serverPid` 不是当前进程、且 `ps -p <pid> -o command=` 能看到该驱动的命令片段（防 pid 复用误杀，判定思路照 `kill-dev` 的保守做法）→ 先杀再继续；
   - 容器里不需要（进程随 cgroup 一起消失），只对 dev / 宿主机部署有意义。
5. **崩溃退避，别刷屏**。连续 3 次失败置 `error` 并停止自动重启；页面「重试」或「测试连接」才重置计数。否则一个地址配错的本地服务会 1 秒一次起进程、把日志刷满。
6. **空闲回收**。`ready` 且 `inflight=0` 超过 5 分钟 → `closing → stopped`（本地 MCP 多半是 node 进程，几十 MB，放着不值）；下次调用重新拉起，冷启动几百毫秒，可以接受。

#### 与关机流程的衔接

`app.close()` 的顺序是：`beforeApplicationShutdown`（StreamHub 关 SSE）→ `httpServer.close()`（等在途请求）→ 各资源的 `onApplicationShutdown`（`apps/server/src/main.ts:96-131`）。连接器池挂在最后一个阶段：

1. 先切 `closing`（不再接新调用），等在途调用最多 `min(3s, shutdownTimeoutMs)`；
2. 再并行 dispose 全部子进程，统一 SIGTERM → 等 3s → SIGKILL；
3. 最后删 pid 文件。

这个过程没跑完就被 SIGKILL 的话，下一次启动的 pidfile 对账会收拾残局——第 4 条就是为它准备的。

#### 多副本部署的一个真问题

本地子进程没法跨实例共享：两个 server 副本各起一份自己的 MCP 进程，而 `ai_connectors.status` 只有一行。多副本时页面读到的「状态」其实是**最后一次写入者的视角**，可能刚好是另一台机器。

一期按单实例（模板默认形态）处理，页面文案写明「状态由当前节点上报」；要做多副本，得把状态挪到按实例的表（`ai_connector_status.connector_id + instance`），页面聚合成「3 台里 2 台可用」。列入 §15 待拍板。

#### 页面怎么呈现

| 元素 | 取值 |
| --- | --- |
| 状态列 | 状态色 + 文案成对：`ok`「已连接」/ `error`「连接失败」/ `unknown`「未验证」 |
| 最近错误 | 展开看 `last_error` 与 stderr 尾部（50 行，脱敏） |
| 操作 | 「测试连接」（probe，不改状态）/「重启进程」（只重启本节点的进程）/「同步」 |

「重启进程」只重建本节点的子进程，不动配置、不动 `ai_tools`；「同步」才会重新列工具。

---

## 10. 后台页面

`apps/admin/src/app/main/ai/connectors/`（照 `ai/tools` 页的拆法：`page.tsx` / `connector-columns.tsx` / `connector-form.tsx` / `config-panels.tsx`）

**列表**：名称、驱动（字典）、状态（状态色 + 文案成对）、工具数、启用开关、最近检查时间、操作（编辑 / 测试连接 / 同步 / 停用）。

**新建 / 编辑**：
- 驱动选择（内置卡片 + 自定义）；
- 驱动专属配置表单（由 `config` 的 schema 生成，沿用 `ModalForm` 的字段声明方式）；
- 密钥（只返回提示串，编辑时不回显明文）；
- 启用开关。

**详情抽屉**：工具清单（只读：key、远端名、说明、参数定义），每行给一个跳转到 `/main/ai/tools` 治理该工具（开关 / 作用域 / 限额在那里改，不重复做）。

**页面顶部口径**（照工具页的做法写清楚，因为它决定「改完看到什么」）：
1. 新建 / 同步后要点「应用变更」才会进提示词（重建 agent 实例，在途对话不受影响）；
2. 关掉连接器 = 工具立刻不可调，但提示词里的清单要等下次重建；
3. 工具的参数定义来自外部服务，只读。

---

## 11. 观测与审计

- **审计**：连接器调用的工具照旧走 `audit-start` / `audit-end` 插件，`ai_tools` 那一行就是它的治理记录；额外在日志里带 `connector_key`。
- **指标**：`ai.connector.call`（tag：`connector`、`ok`）、`ai.connector.sync`（工具数、耗时）、`ai.connector.connect_failed`。走 `@repo/kits` 的 Telemetry，不新建体系。
- **日志**：连接 / 同步 / 失败 / 重建四个事件，字段固定（`connector`、`durationMs`、`toolCount`、`error`），密文不进日志。
- **新结论原因** `upstream`：`tool.outcome` 与时间线 `state` 都要能表达它（`ToolDenyReason` 字典 + 适配器的提示文案两处）。

---

## 12. 分期

### 12.1 一期（P0）

1. 迁移 + 实体 + 字典（`ai_connectors`、`ai_tools` 三列、`upstream` 原因）；
2. 驱动抽象 + 登记机 + `mcp-stdio` 驱动 + 内置「本地文件系统」连接器；
3. 工具构造（`toConnectorToolSpec`）+ 同步服务 + `ai_tools` upsert；
4. 注册机动态段 + `AgentCatalog` 重建 + `ALL_TOOLS` 展开；
5. 后台列表 / 新建 / 编辑 / 测试连接 / 同步 / 应用变更；
6. 启动时对 `enabled` 连接器异步同步（不阻塞启动，失败只记 error）。

### 12.2 二期（P1）

- `mcp-http` 驱动 + 自定义 MCP 连接器（填 URL / 请求头）；
- `webhook` 驱动 + 群机器人样板；
- 实例级限流（每实例每分钟调用数、并发数）与提示词预算（单连接器工具数上限）；
- 图像 / 资源结果落对象存储。

### 12.3 三期（P2）

- `auth: oauth` 驱动能力（授权码 + 刷新）；
- 按用户凭证（`ai_connector_tokens`，前台用户各自授权）；
- 工具白名单 / 排序（工具特别多的服务）。

---

## 13. 验收

### 13.1 测试

| 层 | 用例 |
| --- | --- |
| 驱动 | 契约测试：假 stdio MCP server（`test/fixtures/` 下的 node 脚本，测试里 spawn）+ 假 HTTP server；`listTools` / `callTool` / `probe` / `dispose` 各一条 |
| key 规则 | 长度截断、字符归一化、同连接器撞名、与静态工具撞名 |
| schema 转换 | 正常 JSON Schema → zod；不支持的写法降级为任意对象且记 warn |
| 注册机 | 动态注册 / 移除 / 冲突拒绝；`staticSpecs()` 不含连接器工具；`specs()` 含 |
| 装配 | 重建后在途 run 仍用旧快照（断言取到的实例引用不变）；`ALL_TOOLS` 展开成具体 key |
| 同步 | 远端工具消失 → 行 `enabled=false` 且保留；连接失败 → 工具被移除 + `status=error` |
| 脱敏 | 连接器密钥不出现在出参（`redact` 覆盖） |
| 迁移 | 存量 `ai_tools` 行 `origin='code'` |

### 13.2 检查

`pnpm typecheck`、`pnpm test`、`pnpm check:mastra`（连接器主体不许 import Mastra）、`pnpm check:ui`、`pnpm check:inject`。界面按仓库规矩交用户验，实施后给「看哪个页面、点哪一步、期望看到什么」清单。

---

## 14. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 装配重建改动面大 | 碰到 `ai.module.ts` / `chat.service.ts` / `agent-runner.ts` 三处装配 | 一期先做「显式应用变更按钮」，不做自动重建；重建串行 + 失败保留旧实例 |
| 提示词被工具清单撑爆 | 每轮 token 上涨 | 单连接器工具数上限（默认 20）、说明截断 1000 字、超出给页面提示（不静默丢） |
| 外部服务慢 / 挂 | 拖慢整轮对话 | 连接 10s / 调用 30s 超时，失败给 `upstream` 结论（模型可改口），不炸轮 |
| 自定义 HTTP 连接器被指向内网 | SSRF | 复用联网工具的内网拦截 + env 硬闸 |
| 库被读走 | 凭证泄露 | 沿用明文取舍并如实记录；OAuth 前重新拍板 |
| MCP 协议版本漂移 | 工具发现失败 | 固定 SDK 版本 + `initialize` 时校验 `protocolVersion`，不匹配给明确错误文案 |

---

## 15. 待拍板

1. **MCP 客户端用什么**：引入 `@modelcontextprotocol/sdk`（1.30，node_modules 里已有传递依赖，自带一份 zod 3），还是自研 JSON-RPC（stdio 约 200 行可写；streamable HTTP 的重连 / session / SSE 分支较重）。倾向引入 SDK，用一层 `McpTransport` 包住以便替换。
2. **凭证口径**：连接器密钥继续明文入库，还是单独加密 / 只走 env？一期只接 API key 时沿用明文问题不大；二期 OAuth 前必须重定。
3. **装配重建的触发方式**：显式「应用变更」按钮（推荐） / 同步后自动重建 / 只在启动期注册（最省事，但改连接器要重启）。
4. **按用户授权**是否进 P1。
5. **单连接器工具数上限**默认值（20 还是 50）与超出后的处理（截断保留前 N 个 / 全列但提示）。
6. **多副本时的状态归属**：一期按单实例做（状态写 `ai_connectors.status`，页面文案说明「当前节点上报」），还是直接上按实例的状态表（`ai_connector_status`），页面聚合成「N 台里 M 台可用」。前者省事，后者从第一天就诚实。
