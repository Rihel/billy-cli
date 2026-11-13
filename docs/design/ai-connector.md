# 连接器：让 AI 接外部服务，不用改代码

> **状态：已归档（2026-11-10）。** 连接器的**现状与方向**以
> [`.agents/skills/develop-ai-agent/references/connector.md`](../../.agents/skills/develop-ai-agent/references/connector.md) 为准
> （驱动 `sql` / `redis` / `lark-cli` 已有，`http` / `mcp` 待补；MCP 即一种连接器；按 agent 授权）。
> 本文保留作「目录 / 实例 / 远端能力 / 工具」四层模型与各驱动取舍的历史论证；
> 未实施部分不照本文补，按 skill 的方向做。文中文件路径 / 接口 / 工具名是写作时点
> （2026-11-08 / 11-09）的快照，之后未再逐项随代码更新——例如命令工具已从
> `run-command` 改名 `bash`；当前实现以代码与 `docs/guide/ai.md` 为准。
> 相关：`ai-agent-tool-engine.md`（工具引擎）、`ai-agent.md`（运行时与装配）
> 写作口径：尽量说人话；所有现状描述都对着代码核过，引用处标了文件。

---

## 1. 当前痛点

### 1.1 现在想多一个能力，得走一遍完整发版

Billy 里的工具只有一个来源：代码里的工具组。

```
写一个 @ToolGroup 类            apps/server/src/modules/ai/tools/*.tool.ts
  → 每个 @ToolDecl 方法一个工具
  → 在 AGENT_TOOL_GROUPS 登记     core/tools/tools.types.ts:379
  → 注册机拍平成 key → 工具表     core/tools/tool.registry.ts:63
  → 启动时把声明写进 ai_tools     core/tools/tool.seed.service.ts
  → 渲染进提示词                  agents/index.ts:69
  → 建好 agent 实例               ai.module.ts:208
```

也就是说，想接一个外部服务（飞书、GitLab、公司内部系统），要：**写代码 → 改 agent 授权 → 重启 → 重新审核权限与限额**。对一个"开箱即用的基座"来说，这是硬伤——用户拿到模板，第一件事就是想接自己的东西。

### 1.2 三个具体难受的地方

**① 一件事要改三个地方。** 加工具要动工具组、动 `assistantAgent.tools` 的授权清单、动后台的展示，漏一个就是"写好了但模型调不到"。

**② 端点、密钥、权限散在四处。** 地址可能写在 env、可能写在工具配置、也可能写死在代码；密钥有的在 `ai_tools.secrets`、有的在 env；结果就是**没人说得清"这个能力到底连着谁、用谁的身份、花了谁的钱"**。

**③ 关掉一个能力要发版。** 后台能关的是"这个工具"，不能关的是"这一整家服务"。想停用一整个外部系统，只能改授权清单再发一版。

### 1.3 一句话

> 现在的问题是：**外部服务不是一个"东西"，所以没法被配置、被停用、被审计。**

---

## 2. 连接器介绍

### 2.1 一句话定义

> **连接器 = 连接 AI 和外部系统的东西的统称。**
> 更具体一点：它是一条**后台能配的数据**，绑住一个外部服务（地址 + 密钥），把它提供的能力变成 AI 能调用的工具，并且由我们负责它的连接、状态、限额和回收。

这个名字的重点在"器"：**它是个一直存在的对象，不是一次调用**。一次 `fetch` 不是连接器；一个能被命名、被开关、被撤销的东西才是。

### 2.2 它把四件事收进了同一个对象

| 收进了什么 | 具体是什么 | 没收进来时的样子 |
| --- | --- | --- |
| **身份** | 一行数据、一个 key，可以被引用、可以被撤销 | 地址写在代码或工具配置里，撤销要靠改代码 |
| **凭证** | 一份密钥或一次授权，托管在一处，页面只回提示串 | token 散在 env、工具密钥、调用方参数里 |
| **能力面** | 一组工具，登记进注册机，能治理 | 一个工具自带一个 URL，能力就只有这一个 |
| **生命周期** | 连接、断开、状态、超时、回收都归我们 | 调用方自己 `new Client()`，用完自己关 |

判断一条东西是不是连接器，用一句人话就行：

> **换个协议、换个地址、把它关掉，需要动几个地方？**
> 只动一行数据，就是连接器；要改代码，就不是。

### 2.3 四层结构（最容易混的地方）

```
目录（代码）      内置了哪些"型号"：叫什么、图标、要填哪几个字段
  └ 实例（数据）  用户加的那一条：地址 + 密钥 + 开关
      └ 远端能力  对方给的东西：MCP 的工具清单，或者一个接口
          └ 工具  我们这边的那一份：有稳定的 key，受我们管
```

- **目录**是代码里的常量，跟着版本走。加一种连接器 = 加一条目录。
- **实例**是数据库里的一行。换地址、换密钥、再加一个同类服务，都只改数据。
- **远端能力**的名字和参数由对方定，我们不改。
- **工具**的 key 由我们分配，从此它的开关、限额、审计、脱敏都在我们这边。

能力投影有三种形态，本期做第一种，第三种（`lark-cli` 那类）放在 §3.14 单独说：

| 形态 | 模型怎么得到它 | 例子 |
| --- | --- | --- |
| 工具 | 直接调用 | 数据库查询、MCP 工具 |
| 技能 + 命令通道 | 读文档（技能）→ 自己敲命令 | `lark-cli`（一堆 SKILL.md + 一个命令行） |
| 上下文 | 被动注入 | MCP resources（本期不做） |

### 2.4 什么不算连接器

这条比"什么是"更重要，不然这个词很快变成筐。

| 东西 | 为什么不算 |
| --- | --- |
| `packages/kits` 里的 `LarkClient` / `EmailClient` / `ObjectStorage` | 它们是给业务代码用的客户端，地址和凭证在 env，模型根本摸不到 |
| `Notifier` 的通知通道 | 产出是"发一条通知"这个业务动作，不登记成工具 |
| `ai_providers`（模型供应商） | **形状一模一样**（一行数据、可多条、平台管生命周期），但产出的是"模型"不是"工具"。两个是兄弟，别混成一张表 |
| 一个 MCP server | 它是被接的那一端，连接器是接它这一侧 |
| `bash` / `web-fetch` | 没有"端点"这个对象：一个跑本机命令，一个抓任意网址 |
| 一个工具自带 URL + token | 端点没有独立身份，没法并存两份、没法按端点停用 |

**`web-search` 是个容易误判的**：它的地址和密钥确实都在数据里，但请求体、路径、返回解析全按 DeepSeek 一家写死，所以"换一家还得改代码"。它该不该做成连接器？不该——理由见 §2.5，一句话是**它属于"多个来源、一个能力"，连接器是"一个来源、多个能力"**。

### 2.5 一个来源多个能力 vs 多个来源一个能力

| 形状 | 例子 | 该怎么办 |
| --- | --- | --- |
| 一个来源，多个能力 | 飞书：消息 + 文档 + 日历；知识库：搜 + 读 + 写 | **连接器**：一个实例产出一组工具 |
| 多个来源，一个能力 | 搜索：DeepSeek / Tavily / SearXNG 都是"搜一下" | **供应商路由**：多条配置、选一个主、失败回退，工具面只有一个 |

搜索硬做成连接器会撞三件事：工具 key 绑实例，模型面前会冒出 `deepseek-search`、`tavily-search`，它不会选；限额和审计被拆成多行；还有"没配密钥就借当前模型的密钥"这条回退，凭证属于实例的模型装不下。

所以：**能力比来源多 → 连接器；来源比能力多 → 供应商路由。** 搜索先抽"供应商"（换一家 = 加一行数据），等哪家同时提供搜索 + 抓取 + 抽取了，再给它建连接器。

### 2.6 授权是两层，不是一种

这是飞书教给我们的：**飞书要生成授权链接，用户点进去走 SSO；MCP 配个密钥就完事。** 这是两段流程。

| 层 | 凭证怎么来 | 时序 | 谁给 | 例子 |
| --- | --- | --- | --- | --- |
| **基础层** | 管理员把密钥填进后台 | **同步**，保存即生效 | 管理员 | MCP 的 token、飞书的 appId + appSecret |
| **主体层** | 生成授权链接 → 用户点 → SSO → 回调换 token | **异步**，要等一次浏览器跳转 | 每个用户自己 | 飞书用户身份（读我的日程、私信） |

两层可以叠加：飞书既要基础层（发消息、建文档），又要主体层（读某个人的数据）。**MCP 多数只有基础层**，所以"配个密钥完事"是对的。

一期只做基础层；主体层是二期（要回调路由、按用户的 token 表、按用户的授权状态）。

**没授权时不能把工具藏起来**：工具照常出现在清单里，调用时告诉模型"需要授权"，并把链接带出来。藏起来的话模型只会瞎猜。

---

### 2.7 接入形态一览（别把三个维度混成一个）

"MCP / CLI / custom" 这三个词其实不在一个维度上：

- **MCP、CLI、REST、数据库** —— 说的是**传输与协议**（怎么连）；
- **工具、技能、上下文** —— 说的是**能力怎么描述给模型**（模型怎么知道能用）；
- **内置、自定义** —— 说的是**谁来提供**（我们写死 / 管理员填 / 开发者写驱动）。

设计上三个维度各算各的，组合起来才是一条"接入形态"。

#### 传输维度（我们按这个划分驱动）

| 传输 | 典型对方 | 我们怎么接 | 期次 |
| --- | --- | --- | --- |
| HTTP + MCP | Notion、腾讯文档这类自带 MCP 地址的 | `mcp-http`（官方 SDK） | 第二批 |
| HTTP + REST | GitHub、公司内部接口 | `rest`（声明式工具映射） | 紧随第一批 |
| 数据库 | PostgreSQL / MySQL | `sql`（只读白名单） | **第一批** |
| KV / 缓存 | Redis | `redis`（只读命令白名单） | **第一批** |
| 本地进程 | `lark-cli` 这类命令行 | `cli`（安装 + 授权 + 受限执行） | 二期样板 |
| 对象存储 | S3 / COS | 将来一个 `storage` 驱动（列目录 / 读 / 写） | 未排 |
| 邮件 | IMAP / SMTP | 将来一个 `mail` 驱动（收件箱按条件读、发信） | 未排 |
| 消息队列 | Kafka | **不建议**做成连接器（"消费一条消息"作为工具语义很怪，更适合当业务能力） | 不做 |
| GraphQL | 有 GraphQL 的服务 | 并入 `rest`（body 就是 query 文档），不单列驱动 | — |
| gRPC / SOAP / 私有 RPC | 内部老系统 | 写一个自定义驱动 | 按需 |
| Agent 之间（A2A / ACP） | 别的 agent | 不做——我们已经有 `run-sub-agent` | 不做 |
| 浏览器自动化 | 网页操作 | 不做——`web-fetch` 已经覆盖"读"，"点"这类需求太窄 | 不做 |
| 用户上传插件包 | 第三方写的扩展 | 不做（要沙箱，成本远超收益） | 不做 |
| 本地 stdio MCP | 只给 stdio 的 mcp-server | **不做**（§3.7） | 不做 |

#### 描述维度（能力怎么让模型知道）

| 形态 | 谁在用 | 我们的支持 |
| --- | --- | --- |
| **工具**（有名字、有入参） | MCP、REST、SQL、Redis | 默认形态：`describe()` 交一组 `kind:'tool'` |
| **技能 + 命令通道** | `lark-cli` 这类 | 技能包 + 一个受限 `run` 工具（§3.14） |
| **上下文**（资源） | 知识库、MCP resources | 本期不做；真要做是给同一份定义加一种投影形态 |

#### 提供维度

| 谁提供 | 对应 |
| --- | --- |
| 内置驱动 + 内置目录 | 我们写好型号，管理员只填凭证（数据库、MCP、CLI） |
| 声明式配置 | 管理员填一份 `rest` 工具映射，"自定义"里最常见的一种 |
| 自定义驱动 | 开发者写代码，走 §3.13 的六步 |

**结论**：所谓"custom connector"不是一种传输，而是"管理员自己配一条实例"这个**来源**；它的传输仍然是上面那张表里的某一种。

## 3. 怎么做

### 3.1 总览

```
后台新建连接器（数据）
   │ 同步：连一次，问"你有哪些能力"
   ▼
远端能力清单 ──► 变成我们的工具（ToolSpec）
   │                  │
   │                  ├─► 写进 ai_tools（开关 / 限额 / 审计都挂在这）
   │                  └─► 注册进注册机
   ▼
注册进注册机（工具是请求时现取的，agent 不用重建）
   │
   ▼
模型调用 ──► 既有工具网关（权限、限额、脱敏、分页、审计，一行都不用改）
```

三条原则：

1. **连接器不自建调用通道**。工具被调用的那一秒，走的还是原来的网关插件链。
2. **治理挂在工具行上，不挂在连接器上**。开关、作用域、限额仍然逐工具配；连接器只给总闸和凭证。
3. **工具来源从一份变两份**（代码 + 连接器），治理流程只有一套。

### 3.2 数据表

**新表 `ai_connectors`**（一条 = 一个实例）

| 列 | 类型 | 干什么用 |
| --- | --- | --- |
| `key` | varchar(32) | 实例标识，`[a-z0-9-]`，软删感知唯一；工具 key 用它做前缀 |
| `name` | varchar(64) | 显示名 |
| `driver` | varchar(32) | 用哪套接法：`sql` / `redis` / `mcp-http` |
| `kind` | varchar(16) | `builtin`（内置） / `custom`（用户自己加的） |
| `transport` | varchar(16) | `db` / `http` / `none`，冗余列，给页面筛选用 |
| `auth_base` | varchar(16) | `none` / `secret`（基础层） |
| `auth_subject` | varchar(16) | `none` / `oauth`（主体层，一期恒为 none） |
| `config` | jsonb | 地址、超时、请求头这类**非密钥**配置 |
| `secrets` | jsonb | 密钥。**存法见 §3.8**，接口只回提示串 |
| `enabled` | boolean | 总开关，关掉后它产出的工具全部不可调 |
| `status` | varchar(16) | `unknown` / `ok` / `error`——**只表示上次测试的结论**，不是实时连接状态（不做连接管理，见 §3.7） |
| `last_error` | text | 上次失败的原文（脱敏后） |
| `last_checked_at` | timestamptz | 上次探活 / 同步时间 |
| `tool_count` | int | 上次同步到的工具数 |
| `allowed_tools` | jsonb | 工具白名单（null = 全开），工具太多时用它收口 |

**老表 `ai_tools` 加三列**

| 列 | 默认 | 干什么用 |
| --- | --- | --- |
| `origin` | `'code'` | 来源：`code` / `connector`。存量行自动是 `code` |
| `connector_id` | null | 指向实例。**追溯只认这一列** |
| `remote_tool_name` | null | 对方原来的工具名，调用时原样回传 |

为什么不复用 `source` 列：`source` 记的是"配置是谁改的"（种子 / 人工），"工具从哪来"是另一件事。塞一列，种子同步的判定立刻变复杂。

**几条必须守住的**（都要写成测试）：

- 一个工具行**只有一个来源**：`origin='code'` 时 `connector_id` 必须为空；`origin='connector'` 时必须有值，且指向一个没删的实例；
- 工具 key 全局唯一（沿用现有索引）；前缀只是可读约定，**追溯只认 `connector_id`**；
- 同一个实例里，远端工具名不能重复；
- 实例停用或删除后，它产出的工具立刻不可调，但**行要保留**——历史对话还引用着这些 key；
- 治理粒度仍然是工具行（开关、限额、作用域），实例只管总闸和凭证。

**字典加几个值**：`ToolOrigin`（code / connector）、`ConnectorStatus`、`AuthBase`、`AuthSubject`；`ToolCategory` 加 `connector`；`ToolDenyReason` 加 `upstream`（外部服务不可用）——不能复用 `internal`，那是"我们自己写错了"，混用会让排障和告警说两套话。

### 3.3 目录：内置连接器长什么样

目录是代码里的常量，只干三件事：渲染后台卡片、给表单提供字段、给驱动提供默认值。它**不含凭证，也不决定启停**。

```ts
{
  kind: 'wecom-bot',
  name: { zh: '群机器人', en: 'Group Bot' },
  description: { zh: '往群里发一条消息', en: 'Post a message to a group' },
  driver: 'webhook',
  category: 'office',
  phase: 'available',
  icon: 'message',
  authHint: { zh: '在群设置里添加机器人，复制 Webhook 地址' },
  fields: [
    { key: 'webhookUrl', type: 'url', secret: true, required: true, label: 'Webhook 地址' },
  ],
  allowedTools: null,      // 不限制
}
```

字段声明里的 `secret: true` 决定两件事：这个字段存进 `secrets` 而不是 `config`；`redact` 插件按它脱敏。**不在两处各写一遍**，否则必然漂移。

### 3.4 抽象：一个驱动 = 描述 + 调用 + 就绪 + 准备

前面那张形态表有十几种，但它们只在**四件事**上不一样。把这四件事收进驱动，外面的东西就完全一样了：

| 会变的 | 怎么变 |
| --- | --- |
| **能力从哪来** | 我们自己写死（SQL / REST / Redis / CLI）/ 问对方要（MCP）/ 随包带来（CLI 的技能文档） |
| **怎么执行** | HTTP 请求 / 数据库连接 / 子进程 / SDK |
| **怎么授权** | 不要 / 填密钥 / 跳授权链接 / 先装再登录 |
| **要不要准备与回收** | 装 CLI、写技能目录、建连接池、删目录 |

不变的（实例数据、工具 key、网关治理、审计、脱敏）全在外面，驱动碰不到。

#### 接口

```ts
/** 连接器对外提供的东西只有两种：可调用的工具、可阅读的技能文档 */
type Capability =
  | { kind: 'tool'; name: string; title: string; description: string
      inputSchema: Record<string, unknown>; risk?: 'read' | 'write' }
  | { kind: 'skill-pack'; dir: string; name: string; description: string }

interface ConnectorDriver {
  kind: string
  /** 只给页面筛选用：http / db / process / none */
  transport: 'http' | 'db' | 'process' | 'none'

  // ① 自描述：配置与凭证字段（页面据此渲染表单，脱敏据此取字段）
  config: z.ZodType<Record<string, unknown>>
  secrets: SecretFieldDecl[]

  // ② 授权要求：声明式的，界面照着决定「填表 / 跳链接 / 先装」
  auth: {
    base: 'none' | 'secret' | 'install+secret'
    subject?: 'none' | 'oauth' | 'cli-login'
  }

  // ③ 能力：可以 0..N 个工具，也可以带技能包，两者可同时有
  describe(rt: ConnectorRuntime): Promise<Capability[]>

  // ④ 调用：只有 kind='tool' 的会被调用，name 是描述里给的名字
  invoke(rt: ConnectorRuntime, tool: string, input: unknown): Promise<unknown>

  // ⑤ 就绪：探活 + 授权状态（页面「测试连接」也用它）
  probe(rt: ConnectorRuntime): Promise<{
    ok: boolean
    message?: string
    auth?: 'ok' | 'missing' | 'expired'
  }>

  // ⑥ 准备与回收（可选）：装依赖、写技能包、建池、清目录
  prepare?(rt: ConnectorRuntime): Promise<void>
  dispose?(inst: ConnectorInstance): Promise<void>
}
```

六个成员对应四个变化点，没有第七个。

#### 各形态落进这张表

| 形态 | `describe()` 返回 | `invoke()` 怎么做 | `auth` | `prepare` / `dispose` |
| --- | --- | --- | --- | --- |
| `mcp-http` | 远端发现的工具（0..N） | HTTP 调 `tools/call` | secret / oauth | — |
| `rest` | 配置里声明的工具（0..N） | 拼 URL + query + body，发 HTTP | secret | — |
| `sql` | 写死的 3 个工具 | 连接池 + 只读事务 | secret | dispose 关池 |
| `redis` | 写死的 2~3 个工具 | 连接 + 只读命令白名单 | secret | dispose 关连接 |
| `cli`（lark-cli） | **1 个 `run` 工具 + 1 个技能包** | `execFile`（不走 shell） | install+secret / cli-login | prepare 装 CLI + 写技能目录；dispose 删目录 |
| `storage`（将来） | 写死的几个（列 / 读 / 写） | SDK 调用 | secret | — |
| `mail`（将来） | 写死的几个（按条件读 / 发信） | IMAP / SMTP | secret | dispose 关连接 |
| gRPC / 私有协议 | 写死的工具 | 自定义客户端 | secret / oauth | 视情况 |

**这张表就是"能不能覆盖"的答案**：任何新形态只要回答"返回什么能力、怎么调、怎么授权、要不要准备"，就能接进来，不用改外面的任何东西。

#### 三条不变量（保证抽象不被形态带歪）

1. **没有常驻会话的状态机。** 每次调用现取；连接池、短缓存都是驱动内部的事，不出现在页面上。界面上只有"上次测试的结论"。
2. **一切可调用物都是工具、都走网关；一切文档都是技能、都走技能系统。** 连接器不发明第三条调用路径——这也是它与"包一层 MCP"的根本区别。
3. **能力是"描述出来"的，不是"注册进去"的。** 驱动只交 `Capability[]`，转成 `ToolSpec`（进注册机）和技能目录（进技能系统）是运行时统一做的。

#### 技能包怎么进来（`cli` 这条的关键）

- `prepare()` 把驱动内嵌的技能目录写到 `<skills dir>/connectors/<key>/`；
- `dispose()` 整个目录删掉；目录带 `.managed-by-connector` 标记，避免误删用户自己的技能。

**现在的技能加载器只扫一次**（`skill.loader.ts` 里 `loading` 是常驻缓存，没有 reload），Mastra 那边也是装配期把技能路径解析成静态数组。所以「连接器带来新技能、不重启就生效」要改两处：

1. `SkillLoader` 加一个 `reload()`（清缓存 + 重扫目录）；
2. `ai.mastra.ts` 的 `skills` 改用 Mastra 支持的 resolver 形态（每请求解析，`skills/types.d.ts:88` 有定义），而不是装配期一次性数组。

这两处排到 `cli` 那期——第一批数据库不涉及技能包。

### 3.5 工具怎么进来

能力的两种来源在这里分岔：`kind='tool'` → 变成 `ToolSpec` 进注册机；`kind='skill-pack'` → 落到技能目录，进技能清单。连接器本身不碰这两套系统。

**① 工具 key 怎么定**

`c-<实例 key>-<远端名>`，全小写，非 `[a-z0-9-]` 换成 `-`，总长 ≤ 64（受 `ai_tools.tool_key` 的 varchar(64) 限制）。

**只当可读约定，不做反向解析**。实例叫 `fs-home`、工具叫 `read-file`，和实例叫 `fs`、工具叫 `home-read-file`，拼出来一模一样。追溯一律查 `connector_id`。

**② 注册机要能装两段**

现在注册机在构造期吃死 `AGENT_TOOL_GROUPS`，key 重复就直接启动失败。要加：

- `registerDynamic(connectorId, specs[])` / `removeDynamic(connectorId)`；
- `staticSpecs()` 只给种子同步用（否则种子会把连接器工具当成"代码声明"反复覆盖）；
- 冲突、重名一律拒绝并记错误日志，不炸进程。

**③ 不用重建：Mastra 的工具面本来就是动态的**

原来以为"工具变了必须重建 agent"，查了 SDK（`@mastra/core@1.82`）发现不用：

```ts
// AgentConfig 里两处都支持 resolver（每请求解析）
tools?:  DynamicArgument<TTools, TRequestContext>
skills?: SkillInput[] | ((ctx) => SkillInput[] | Promise<SkillInput[]>)
```

所以我们只需要：

```ts
// 现在：tools 是启动时算死的一张表
tools: resolveTools(definition.tools)

// 改成：每个请求从注册机现取
tools: ({ requestContext }) => toMastraTools(registry.toolbox(keysOf(definition, requestContext)))
```

三个后果，都是好消息：

1. **不用 `AgentCatalog`、不用「应用变更」按钮**。连接器同步完，下一次请求模型就能看到新工具（工具定义是随请求下发的，不是启动时烙死的）。
2. **提示词里那段"可用工具"只影响文字说明**。它是按会话首轮生成的快照（`chat.service.ts` 的 `resolveSystemPrompt`），老会话不会自动补上新工具的描述——但工具本身照样能调。所以文案上写一句"工具以实际可用为准"就够，不必为此重建。
3. **授权清单可以动态展开**：`assistantAgent.tools` 现在写死 key 列表，加一个 `ALL_TOOLS` 标记，解析时展开成"此刻注册机里的全部 key"——照 `skills: [ALL_SKILLS]` 的现成做法。

唯一还要小心的是**性能**：`toMastraTools` 每次请求都会跑一遍，注册机按"版本号"缓存一次转换结果即可（注册机变了就 +1）。

### 3.6 同步一次发生了什么

```
点「同步」（或服务启动时，对已启用的连接器逐个做）
  1. 连上对方（懒建客户端）
  2. 问工具清单；数量、重名、长度都校验一遍
  3. 事务里 upsert ai_tools：
       origin='connector'、connector_id、remote_tool_name
       title / description / param_schema 用对方的（只读镜像）
       对方已经不存在的工具 → enabled=false（行保留）
  4. 注册进注册机
  5. 注册进注册机（下一次请求模型就能看到）
  6. 更新实例的 status / tool_count / last_checked_at
```

哪一步失败：实例标 `error`，把这家之前注册的工具**先摘掉**（避免"页面显示失败、实际还能调"），页面给「重试」。

对方删掉一个工具时**不删行**：历史对话还引用着这个 key，删了就查不出当年调了什么。

### 3.7 不做本地进程（本期，已拍板）

**结论：本期不做 `stdio` 传输，也就不做"在服务器上拉起 MCP 子进程"这件事。**

理由是它带来的复杂度与收益不成比例：

| 做 stdio 要付的代价 | 收益 |
| --- | --- |
| 进程状态机（idle / starting / ready / closing / crashed）、stderr 泄流、进程组回收、孤儿 pidfile 对账、崩溃退避、空闲回收 | 能用只提供 stdio 的本地 MCP server |
| `node --watch` 重启与被 `kill -9` 都会漏孤儿；`pnpm kill:dev` 抓不到 | — |

不做之后：省内一套状态机、省一张 pid 表、省"子进程泄漏"这一类线上问题。**要接的东西只要能走 HTTP（MCP 或 REST）或连库，都照样能接。**

真有人要接本地 MCP server，绕法很简单：让那个 server 自己监听一个端口，用 `mcp-http` 连它——进程由用户自己管，不归我们。

以后要补 stdio，结构上仍然是一个驱动（`transport: 'stdio'`）+ 一个进程池，不影响其它设计。

#### MCP 也只当"一个远端地址 + 几个请求头"

第三方（腾讯文档、微云、会议、乐享、Notion…）都直接给 MCP 地址，我们连过去就行，不需要在服务器上托管任何 MCP。所以对 `mcp-http`：

- **不维护会话状态**：没有 `starting / ready / closing`，没有心跳、没有后台巡检；
- **不常驻连接**：按实例缓存一个客户端（空闲 5 分钟丢），调用失败就重建一次；
- **库里只记"上次测试"**：`enabled` + `last_probe_ok` + `last_probe_at` + `last_error`，不代表"现在连着"；
- **工具清单按指纹缓存**：指纹 = 地址 + 请求头 + 传输，变了才重新 `tools/list`。

一句话：**MCP 对我们是一个 HTTP 端点，不是一台要养的服务器。**

### 3.8 密钥与授权

**基础层（一期）**：管理员在后台填密钥 → 入库 → 立刻能「测试连接」。没有浏览器、没有回调。

**主体层（二期）**：一轮带浏览器的流程。

```
用户点「授权」
  → 服务端建一条授权会话（Redis，10 分钟）：connectorId + userId + state + PKCE
  → 拼授权链接（client_id / redirect_uri / scope / state / challenge）
  → 用户登录（SSO）并确认权限
  → 回到固定回调 /connector/oauth/callback?code&state
  → 校验 state（一次性、绑定发起人）→ 服务端用 code 换 token
  → 写 ai_connector_tokens(connector_id, user_id) → 跳回页面
```

三条硬规矩：**回调地址固定**（不然就是开放重定向，token 送到别人手里）、**state 一次性**、**换 token 在服务端**（`client_secret` 绝不下发浏览器）。

**存法（已拍板）**：**不加密**，沿用 2026-10-01 的明文口径（与 `ai_tools.secrets`、`ai_providers.api_key` 一致）。补偿仍然是那两条：接口只回提示串、日志与出参走脱敏。

代价照实记：**库被读走就等于凭证泄露**（备份、只读账号、日志转储同理）。主体层的 refresh token 也走这条——它比静态 key 更敏感（能长期冒充某个人），等做主体层时再单独确认一次，现在不做加密。

**其他安全边界**：

- **数据库连接账号必须低权限、只读**——代码只能挡写语句，挡不住超级用户函数（`pg_read_file`、`COPY … TO PROGRAM`、MySQL 的 `INTO OUTFILE`），所以账号权限是第一道闸；
- 自定义连接器只开 http 传输，页面不给"命令"输入框（不做 stdio 之后这条自然消失，但边界要写下来）；
- 出网复用联网工具那套内网拦截（`AGENT_WEB_*` 那套判断），SSRF 不新开一条口子；
- 对方返回的内容一律当数据看（可能带提示词注入），工具说明里写明；
- 单次响应 2 MB 截断，给模型的页仍由分页插件统一处理。

### 3.9 未配置 / 过期了怎么提醒（改为：网关插件为主）

你说得对，**不用往提示词里塞**——工具网关本来就是所有调用的必经之路，在那里拦一道最准确。

做法：插件链里加一个 `connector-guard`，位置在 `enabled` 之后、`exec` 之前：

```ts
// plugins/connector-guard.plugin.ts
check(ctx) {
  const inst = connectorOf(ctx.settings)        // 从工具行上的 connector_id 拿实例
  if (!inst) return null                        // 代码工具，放行
  const state = inst.stateFor(ctx.caller?.userId)  // 未配置 / 未授权 / 过期 / 已停用
  if (!state) return null                       // 正常，放行
  return {
    ok: false,
    reason: 'precheck-failed',
    message: `${inst.name}：${state.label}`,
    hint: state.kind === 'authorize'
      ? `让用户点开 ${baseUrl}/connector/authorize/${inst.id} 完成授权`
      : '请在后台「AI → 连接器」补全配置',
    retryable: false,
  }
}
```

它的好处：**状态永远是最新的**（每次调用现查），也不会因为提示词快照过期而说错话。

它的局限也要认：**只有模型真去调这个工具时才会触发**。如果用户从头到尾没提相关需求，就不会有提醒。真需要"开场就提醒"，再加一条首轮注入（现在的代码里已经有注入点：`resolveSystemPrompt` 旁边就是运行环境那段），做成配置开关，默认关。

所以分工是：**网关插件负责"说对"，首轮注入负责"主动"**；本期只做前者。

### 3.10 后台页面

`/main/ai/connectors`，三块：

- **列表**：名称、驱动、状态（颜色 + 文案成对）、工具数、开关、上次检查时间、操作；
- **新建 / 编辑**：选型号 → 按字段声明渲染表单（密钥只回提示串）→ 测试连接；
- **详情**：工具清单（只读）、测试连接、同步。

页面顶部写清三句话（跟工具页一个风格）：

1. 新建 / 同步后，下一次对话就能用（不用重启，也没有「应用变更」）；
2. 关掉连接器 = 工具立刻不可调；老会话的提示词里可能还写着它，以实际可用为准；
3. 工具的参数定义来自对方，只读。

### 3.11 第一批做什么：数据库（已拍板）

第一批做**数据库连接器**：PostgreSQL、MySQL、Redis。它们有真实价值（模型能直连查数据），又完全不需要外部账号审批。

| 步 | 连接器 | 驱动 | 这一步新增的失败面 | 依赖 |
| --- | --- | --- | --- | --- |
| 1 | PostgreSQL | `sql`（dialect=postgres） | 目录 → 实例 → 同步 → 注册机 → 动态工具 **整条链路**；连接池、超时、只读 | 本机 docker 就有 PG |
| 2 | MySQL | `sql`（dialect=mysql） | 第二套方言与驱动库（要加 `mysql2` 依赖） | 一个 MySQL 实例 |
| 3 | Redis | `redis` | 命令白名单、键前缀、游标 | 本机 docker 就有 Redis（6380） |

每个连接器给三到四个工具（都写死在驱动里，不需要对端发现）：

- SQL：`list_tables` / `describe_table` / `query`（只读）
- Redis：`scan_keys` / `get` / `hgetall`（只读命令白名单）

**安全默认值**（这部分比功能重要）：

- 工具默认 `scope='admin'`——只有管理员对话能调，要放开给前台得显式改；
- `query` 只放行 `SELECT` / `WITH` / `EXPLAIN` / `SHOW` / `DESCRIBE`，且只允许单条语句；
- 会话级只读（PG `BEGIN READ ONLY`，MySQL `START TRANSACTION READ ONLY`）。这只挡写，不挡超级用户函数（`pg_read_file` 之类）——所以文档必须写明：**连接用的账号要低权限、只读**，不要用超级用户；
- 结果行数上限（默认 200）+ 超时（默认 10s）；字节上限继续交给分页插件；
- Redis 只读命令白名单，禁 `KEYS`（全量扫）、`FLUSH*`、`CONFIG`、`EVAL`；默认限定键前缀。

**Webhook 为什么不在第一批了**：它原来的作用是"最小形状、验证整条链路"，而 `sql` 驱动的 `describe()` 也是静态清单，已经把这个角色覆盖了。等需要"往群里发消息"时再加，一天的事。

**同批可加**：`mcp-http` 驱动 + 自定义 MCP 入口（长尾服务），排在数据库三步之后。

**怎么算做完**：后台新建一条 PG 连接器（填 host / database / 只读账号）→ 测试连接通过 → 同步出三个工具 → 新开一轮对话，模型能调 `list_tables` 并在时间线里看到结果 → 把实例关掉，下一轮调用直接给"已停用"的结论。Redis 与 MySQL 各重复一遍。

### 3.12 工具太多怎么办（照 Octop：分两级收，不用 RAG）

先说结论：**Octop 没有用向量检索，也没有"按需加载工具"**。它用两个很笨但有效的闸门：

**第一级：按「连接器」选本次带哪些，而不是全量加载。**

- 每个连接器有个 `default_open`（默认带上）；
- 每次请求可以显式指定 `mcp_servers` 列表；
- 合并规则：`explicit` 为空才用默认；可以强制"只用显式指定的"（`apply_defaults=false`），也可以强制"显式 + 默认都要"（Cron / IM 场景）。

对应到我们：**每轮对话可以选"这次带哪几个连接器"**，默认只带常用的那几个。粒度是连接器，不是工具——实现最简单（就是一个 key 列表），模型也理解得了。

**第二级：每个连接器一份 `allowed_tools` 白名单。**

Octop 在 catalog 里静态声明（`allowed_tools: tuple[str, ...] | None`），构 MCP 配置时写进 `spec["allowed_tools"]`，由 agent 框架过滤。

对应到我们：`ai_connectors.allowed_tools`（已有这一列），空 = 全开。

**为什么不做 RAG**：

- 工具的 schema 必须随请求下发，模型没见过就调不了——所以 RAG 只能决定"给哪几个"，不能"用到再给"；
- 要 embedding 服务、索引要跟连接器同步；漏掉一个关键工具的代价（模型干不了活）比省下的 token 高；
- 结果不可解释：用户问"你为什么没有那个工具"时答不上来。

**如果两级还不够**（比如单个连接器就 200 个工具），再做第三级：

| 方案 | 做法 | 什么时候才值得 |
| --- | --- | --- |
| 分组 | 连接器工具挂到子 agent 上（`childToolbox()` 已有），主 agent 只带委派 | 工具天然按业务域分得开 |
| 关键词搜索 | 加 `tool_search`（学 Mastra 的 `skill_search`），先检索再决定给谁 | 工具说明写得好、可搜 |
| 向量检索 | 工具说明做 embedding，按问题取 top-k | 前面都不够，且能接受不可解释 |

顺序就是：**连接器级选择 → 连接器内白名单 → 分组 → 关键词搜索 → 向量**。本期只做前两级。

### 3.13 怎么自定义一个「非 MCP」的连接器

「非 MCP」的意思是：对方没有一个 MCP 地址，只有一个 HTTP 接口、一个数据库、或者一个自家协议。按代价从低到高分三条路。

#### 路线一：不写代码，用内置的通用驱动

先看对方是什么形态，对号入座：

| 对方是什么 | 用哪个驱动 | 你要填的 |
| --- | --- | --- |
| REST / JSON 接口（有文档，几十个路径） | `rest` | baseUrl + 密钥 + 一份「工具映射」 |
| 只有一个动作，比如"往某个地址 POST 一条消息" | `rest`（单工具） | 一个 URL + 一个固定 body 模板 |
| PostgreSQL / MySQL | `sql` | host / port / database / 只读账号 |
| Redis | `redis` | host / port / 密码 / 键前缀 |
| 对方自己提供 MCP 地址（腾讯文档、Notion 这类） | `mcp-http` | MCP URL + 请求头 |
| 自家 RPC / gRPC / SOAP / 私有鉴权 | 路线三：写驱动 | 代码 |

**多数「自定义连接器」其实就是路线一。** 管理员在后台选「自定义」，填完这几项，不用发版。

#### 路线二：写一份`rest` 工具映射（重点）

`rest` 驱动的全部能力就是一份 JSON：**每个工具声明它的方法、路径、参数放哪、响应取哪**。下方是接 GitHub 的例子（后台表单里就是这些字段）：

```jsonc
{
  "baseUrl": "https://api.github.com",
  "headers": {
    "Authorization": "Bearer {{secret.token}}",   // 只能用 {{secret.xxx}} 取密钥
    "Accept": "application/vnd.github+json"
  },
  "timeoutMs": 15000,
  "tools": [
    {
      "name": "search-issues",
      "title": "搜索 issue",
      "description": "按关键词搜索 issue，返回标题、状态和链接。只在已知仓库/关键词时用。",
      "method": "GET",
      "path": "/search/issues",
      "params": {                                  // 给模型的入参（JSON Schema）
        "type": "object",
        "properties": {
          "q": { "type": "string", "description": "搜索表达式，如 repo:vercel/next.js is:open" },
          "perPage": { "type": "number", "default": 10 }
        },
        "required": ["q"]
      },
      "query": ["q", "perPage"]                    // 这几个参数放 query string
    },
    {
      "name": "create-issue",
      "title": "创建 issue",
      "description": "在指定仓库创建一条 issue。",
      "method": "POST",
      "path": "/repos/{owner}/{repo}/issues",
      "params": {
        "type": "object",
        "properties": {
          "owner": { "type": "string" },
          "repo": { "type": "string" },
          "title": { "type": "string" },
          "body": { "type": "string" }
        },
        "required": ["owner", "repo", "title"]
      },
      "pathParams": ["owner", "repo"],             // 这几个填进路径占位符
      "body": ["title", "body"],                    // 这几个放进 JSON body
      "pick": "html_url"                            // 响应只留这一个字段
    }
  ]
}
```

规则只有这几条，都是为了让"声明"保持成声明、不变编程语言：

- **方法**：`GET / POST / PUT / PATCH / DELETE`；`GET` 不允许带 body；
- **路径**：必须以 `/` 开头，**不能是完整 URL**（防止把 host 换掉绕过校验），`{name}` 占位符必须在 `pathParams` 里出现同名参数；
- **参数搬位**：`pathParams` / `query` / `body` 三个数组决定入参去哪；没列进去的参数直接丢弃（不静默塞进 body）；
- **请求头**：只允许 `{{secret.xxx}}` 占位，禁止任意模板表达式；
- **响应**：默认原样返回 JSON；`pick` 支持点路径（`data.items`）取子树；大结果交给分页插件，驱动这边只做 2 MB 截断；
- **超时**：与连接器配置一致，默认 15 秒。

**校验发生在保存时**，不是调用时：路径合法、占位符与参数对得上、工具名不重复、`secret` 引用存在、URL 不指向内网（除非部署开关打开）。保存不通过就不让存——比"存下来再在对话里报错"好排查得多。

**不做的事**（否则这就不再是配置，而是给管理员一个远程代码执行 + SSRF 的组合）：不做脚本、不做任意模板、不做响应内 JS/JSONPath 变换、不做多步编排（先查 A 再用结果调 B）。多步应该写成工具让模型串，而不是塞进一份配置里。

#### 路线三：写一个新驱动（代码级）

> **现行代码的落地步骤**（目录条目 + `defaults` + 驱动 + `ai.module` 注册 + 测试）见
> [`ai-extension-guide.md`](./ai-extension-guide.md) §3；本节讲的是"为什么要这么分"。

只有当对方不是 HTTP、不是 SQL、不是 MCP 时才走这条：自家 RPC、gRPC、SOAP、私有签名鉴权（比如需要 HMAC、需要多步换 token）。

六步，都落在固定位置：

```ts
// ① 目录：加一条型号（决定后台卡片与表单）
// connectors/catalog/acme-rpc.ts
export const acmeRpc: ConnectorCatalogEntry = {
  kind: 'acme-rpc',
  name: { zh: '内部 RPC', en: 'Acme RPC' },
  driver: 'acme-rpc',
  category: 'self_hosted',
  phase: 'available',
  fields: [
    { key: 'endpoint', type: 'url', secret: false, required: true, label: '服务地址' },
    { key: 'appId', type: 'text', secret: false, required: true, label: 'AppId' },
    { key: 'appSecret', type: 'password', secret: true, required: true, label: 'AppSecret' },
  ],
}

// ② 驱动：实现 describe / invoke / probe
// connectors/drivers/acme-rpc.driver.ts
@Injectable()
export class AcmeRpcDriver implements ConnectorDriver {
  kind = 'acme-rpc'
  transport = 'http' as const
  config = z.object({ timeoutMs: z.number().int().positive().default(10_000) })
  secretFields = [{ key: 'appSecret', secret: true }]

  async describe(): Promise<Capability[]> {
    return [{ kind: 'tool', name: 'query-user', title: '查用户', description: '按手机号查用户档案',
              inputSchema: { type: 'object', properties: { phone: { type: 'string' } }, required: ['phone'] }, risk: 'read' }]
  }

  async invoke(rt: ConnectorRuntime, name: string, args: unknown) {
    if (name !== 'query-user') throw new Error(`未知工具：${name}`)
    const { phone } = z.object({ phone: z.string() }).parse(args)
    const body = sign({ appId: rt.config.appId, phone, ts: Date.now() }, rt.secrets.appSecret)
    const res = await fetchGuarded(`${rt.config.endpoint}/user/query`, { method: 'POST', body, ... })
    return res.json()
  }

  async probe(rt) { /* 调一个最轻的只读接口 */ }
}

// ③ 注册：与 AGENT_TOOL_GROUPS 同一个写法
{ provide: CONNECTOR_DRIVERS, inject: [...], useFactory: (...) => new Map(...) }

// ④ 一个连接器工具的组装不用你写：toToolSpec(inst, driver, remote) 统一完成
// ⑤ 测试：describe / invoke / probe 各一条，加上"出错时是 upstream 结论而不是崩"
// ⑥ 文档：在 connectors/README 里加一行，说明它需要什么凭据、能干什么
```

写驱动时**不用碰的东西**：不用碰注册机、不用碰工具网关、不用碰 `ai_tools`、不用碰后台页。这四样都由现有的链路负责——驱动只回答"怎么连、怎么调"。

#### 什么时候不该自定义

先问三个问题，能省掉一半的重复劳动：

1. **对方是不是已经有 MCP 地址？** 有就用 `mcp-http`，别手写。
2. **是不是一个普通 HTTP 接口？** 是就用 `rest` 声明，别写代码。
3. **是不是只是"多步调用"？** 那是模型的事（工具串起来），不是连接器的事。

### 3.14 技能型集成：`lark-cli` 这种「装完就有一堆技能」的工具

它和前面三种都不一样：**没有工具清单，能力全在"模型读完文档去敲命令"**。所以别硬塞进"连接器产出工具"这个框里，拆成三块，各归各位。

| 块 | 归谁 | 现状 |
| --- | --- | --- |
| **技能**（怎么用：哪个命令、什么参数、什么坑） | 现有技能系统（`SkillLoader` + `skill` / `skill_read` 工具） | **已经跑通，不用改** |
| **运维**（装 / 配 / 授权 / 状态） | 新增 `cli` 驱动 | **已落地（2026-11-09）**：镜像预装 + `lark-cli` 驱动 |
| **执行**（真去敲命令） | 连接器产出的一个受限 `run` 工具 | **已落地**：`run`（参数白名单 + `spawn`） |

> **落地差异（2026-11-09）**：样板按"运维前置"实现，和下面的原方案有四处不同——
> 1. 安装放在**镜像**里（`docker/Dockerfile.server` 固定版本装 `@larksuite/cli`），驱动不做运行期 `npm i -g`；
> 2. 技能不落盘到 `AGENTS_SKILLS_DIRS`，而是让模型用 `lark-cli skills list/read` 读**二进制内嵌文档**（24+ 份，省系统提示词）；
> 3. 授权也走 `run` 工具（`auth login --no-wait` / `--device-code`），没有单独的 `/connector/cli/*` 接口；
> 4. 每个连接器实例一个独立 `HOME`（`~/.billy/lark-cli/<实例 id>`），App 凭证写进该实例自己的 CLI 配置，删连接器时整目录删掉。
>
> 原方案保留作对照；差异只在"装 / 文档 / 授权接口"三处，命令白名单与受限执行的思路不变。

#### 三块具体怎么摆

**① 技能是文档，不是连接器。** `lark-cli` 的 17 个业务域，本质是一堆 `SKILL.md`：清单进提示词，正文由 `skill_read` 按需读。这套我们已经有了（技能目录 + `AGENTS_SKILLS_DIRS`）。连接器要做的是**把这些文档装进一个受管目录**：`<skills dir>/connectors/<key>/`，删连接器时一起删。

**② 连接器只管"环境与凭证"。** `cli` 驱动回答四件事，全是运维，不是能力：

```ts
interface CliDriverSpec {              // 写死在驱动里，管理员改不了
  binary: string                       // 'lark-cli'
  install: string[]                    // ['npm', 'i', '-g', '@larksuite/cli']
  versionArgs: string[]                // ['--version']
  initArgs: (cfg) => string[]          // ['config', 'init', ...]
  authArgs: string[]                   // ['auth', 'login']
  statusArgs: string[]                 // ['auth', 'status']  → 解析成 { authorized, user }
  runAllowlist: string[]               // 允许的子命令前缀：['im', 'docs', 'base', 'calendar', ...]
  skillPack: string                    // 技能包目录（随连接器一起写盘）
}
```

- **安装**：后台点「安装」，跑 `npm i -g`，把版本与路径回报到页面（异步任务 + 状态）；
- **配置**：`appId` 进 `config`、`appSecret` 进 `secrets`，执行时通过 env / profile 传给 CLI；
- **授权**：拉起 `auth login`，它打印一个链接 → 我们把链接给用户（走已有的 `connector-guard` 提示或首轮注入）→ 后台轮询 `auth status` 直到 `authorized`；
- **状态**：`statusArgs` 的输出解析成 `unknown / authorized / expired`；页面上的"测试连接"就是再跑一次 `auth status`。

**③ 执行只出一个工具，而且受限。** 连接器产出 `run(args)`：`args` 是子命令 + 参数数组，驱动按 `runAllowlist` 校验第一段，用 `execFile`（**不走 shell**）执行，禁止管道与重定向；输出交分页与脱敏，审计带 `connector_key`。

这样一个连接器就给模型三种东西：**技能文档（怎么用）+ 一个执行通道（去做）+ 状态（能不能做）**。

#### 代价，写清楚再决定

| 代价 | 说明 |
| --- | --- |
| 宿主机要有 Node 工具链 | `npm i -g` 要在服务器或镜像里能跑；Windows 的路径与权限另算 |
| 用户 token 落在 CLI 的磁盘目录 | 我们删连接器**不能保证撤销干净**——这是它和"凭证由我们托管"的根本差别 |
| 版本会漂移 | CLI 参数变了，技能文档就过时；升级要跟着改文档 |
| 不能跨副本共享 | 每台机器各装一份、各授权一份（和 §6.3 的多副本问题同源） |

所以结论是：**能集成，而且它给的能力很多；但它用"运维负担"换来的，适合放二期、只做一个样板。**

#### 更干净的替代路线

如果不想要上面这些负担：用 `rest` / `mcp-http` 直接接飞书 OpenAPI 的**高频几个接口**（发消息、读文档、查日程），不装 CLI。代价是要自己写工具映射，好处是凭证在我们手里、没有宿主依赖、多副本天然一致。

两条路的取舍可以概括成一句话：**要"现成的广覆盖"就用 CLI 型；要"干净可控"就用 `rest` 声明几个接口。**

### 3.15 明确不做

- 厂商卡位（腾讯文档 / TAPD / 乐享 / QQ 邮箱）：模板替厂商托管用户凭证不现实，交给自定义 MCP；
- 搜索做成连接器（§2.5）；
- 把厂商 CLI（`lark-cli` 那类）放进第一批：代价见 §3.14（宿主机工具链、token 在磁盘、版本漂移），放二期只做一个样板（**2026-11-09 已作为样板落地，见 §8**）；
- 按用户建实例：我们是管理员配一次、全员可用；只有"以某人身份办事"时才按用户存**凭证**；
- 本地 MCP 进程（stdio）：见 §3.7；
- 主体层授权（授权链接 + SSO）：二期，见 §6.3。

---

## 4. 收益评估

### 4.1 谁受益，受益在哪

| 角色 | 现在的样子 | 有了连接器 |
| --- | --- | --- |
| 用模板的开发者 | 接第二个外部服务 = 再抄一遍工具组 + 改授权清单 + 重启 | 后台加一行数据，同步即可 |
| 管理员 | 不知道"这个能力连着谁、用谁的钱" | 一条连接器就答完：地址、密钥、额度、谁能用 |
| 排障的人 | 外部服务挂了，只看到工具报错 | 连接器状态 + 最近错误 + 工具调用的 `upstream` 结论 |
| 安全 / 审计 | 密钥散在 env 与工具配置 | 一处托管、一处脱敏、一处审计 |

最实际的一条：**关停一个外部系统从"发版"变成"点一下"。**

### 4.2 成本（按改动面，不拍工时）

| 改动 | 量 |
| --- | --- |
| 数据库 | 1 张新表 + `ai_tools` 3 列 + 1 个迁移 |
| 依赖 | 新增 `mysql2`（PG / Redis 的库已有：`pg`、`ioredis`） |
| 新增文件 | 约 7~9 个（实体、目录、驱动接口、`sql` 驱动、`redis` 驱动、同步服务、后台接口） |
| 装配改动 | 2 处（`ai.module.ts` 的 provider、`ai.mastra.ts` 的 `tools` 改成 resolver）；**不需要 AgentCatalog** |
| 注册机 | 1 处（动态段 + 版本号） |
| 种子同步 | 1 处（跳过连接器行） |
| 网关 | 1 个插件（`connector-guard`） |
| 后台 | 2 个页面 + 1 个详情抽屉；SDK 与 schema 各 1 处 |
| 测试 | 只读 SQL 判定、Redis 白名单、key 规则、动态注册、同步、脱敏、迁移，约 7 组 |

比上一版省掉的是"进程池 + 进程状态机 + pidfile 对账"（因为不做 stdio），以及"AgentCatalog + 应用变更"（因为工具面本来就能动态解析）。

### 4.3 风险

| 风险 | 应对 |
| --- | --- |
| 工具面动态解析动到主链路 | 改动局限在 `ai.mastra.ts` 的 `tools` 解析处；按注册机版本号缓存转换结果，异常时回落到静态清单 |
| 工具太多把提示词撑爆 | `allowed_tools` 白名单 + 说明截断 + 超出给页面提示（不静默丢） |
| 外部服务慢 / 挂 | 连接 10s、调用 30s 超时；失败给 `upstream` 结论（模型可改口），不炸整轮 |
| 自定义连接器被指向内网 | 复用联网工具的内网拦截，env 硬闸 |
| 子进程泄漏 | pidfile 对账 + 进程组回收 |
| 凭证明文泄露 | 建议默认加密；至少做到接口不回明文、日志与出参脱敏 |
| 多副本状态不准 | 一期按单实例，文案说明由当前节点上报 |

### 4.4 什么时候算回本

三个可观察的节点：

1. **接第二个外部服务不用改代码**（这是当初的痛点，直接对应）；
2. **一次配置错误不再是发版事故**（关掉 / 改地址只动数据）；
3. **问"这个能力是谁的、花了多少"能在后台一页答完**（现在答不完）。

---

## 5. 伪代码实现

下面只写"形状"，不写完整实现；变量名与仓库现有命名保持一致。

### 5.1 目录与字段声明

```ts
// apps/server/src/modules/ai/connectors/catalog/wecom-bot.ts
export const wecomBot: ConnectorCatalogEntry = {
  kind: 'wecom-bot',
  name: { zh: '群机器人', en: 'Group Bot' },
  driver: 'webhook',
  category: 'office',
  phase: 'available',
  authHint: { zh: '群设置 → 添加机器人 → 复制 Webhook 地址' },
  fields: [
    { key: 'webhookUrl', type: 'url', secret: true, required: true, label: 'Webhook 地址' },
  ],
}

// 启动校验：kind 唯一、driver 存在、fields 的 key 不重复、每个字段有 label
export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  wecomBot, fsLocal, github, ...
]
```

### 5.2 驱动接口与注册

```ts
// connectors/connector.driver.ts（不 import @mastra，check:mastra 会守）
export type Capability =
  | {
      kind: 'tool'
      name: string                  // 连接器内的名字（最终 key 由我们拼）
      title: string
      description: string
      inputSchema: Record<string, unknown>
      risk?: 'read' | 'write'       // 给页面与告警看，不参与运行时判定
    }
  | {
      kind: 'skill-pack'            // 技能文档目录（可以是绝对路径或包内资源）
      dir: string
      name: string
      description: string
    }

export interface SecretFieldDecl {
  key: string
  label: string
  secret: boolean                   // true → 进 secrets；false → 进 config
  required?: boolean
  type?: 'text' | 'password' | 'url' | 'number'
}

export interface ConnectorRuntime {
  key: string
  config: Record<string, unknown>
  secrets: Record<string, string>   // 只在本次操作内使用，禁止落库 / 进日志
  signal?: AbortSignal
}

export interface ConnectorDriver {
  kind: string
  transport: 'http' | 'db' | 'process' | 'none'
  config: z.ZodType<Record<string, unknown>>
  secrets: SecretFieldDecl[]
  auth: { base: 'none' | 'secret' | 'install+secret'; subject?: 'none' | 'oauth' | 'cli-login' }
  describe(rt: ConnectorRuntime): Promise<Capability[]>
  invoke(rt: ConnectorRuntime, tool: string, input: unknown): Promise<unknown>
  probe(rt: ConnectorRuntime): Promise<{ ok: boolean; message?: string; auth?: 'ok' | 'missing' | 'expired' }>
  prepare?(rt: ConnectorRuntime): Promise<void>
  dispose?(inst: ConnectorInstance): Promise<void>
}

// 装配：与 AGENT_TOOL_GROUPS 一个写法；启动期校验 kind 唯一、config.parse({}) 成功
{ provide: CONNECTOR_DRIVERS, inject: [SqlDriver, RedisDriver, McpHttpDriver, RestDriver],
  useFactory: (...ds) => new Map(ds.map((d) => [d.kind, d])) }
```

### 5.3 第一个驱动：数据库（PG / MySQL）

```ts
@Injectable()
export class SqlDriver implements ConnectorDriver {
  kind = 'sql'
  transport = 'db' as const
  config = z.object({
    dialect: z.enum(['postgres', 'mysql']),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(5432),
    database: z.string(),
    statementTimeoutMs: z.number().int().positive().default(10_000),
    maxRows: z.number().int().positive().max(5_000).default(200),
  })
  secretFields = [{ key: 'user', secret: false }, { key: 'password', secret: true }]

  // 工具清单是我们写死的，不需要对端发现
  async describe(): Promise<Capability[]> {
    return [
      { kind: 'tool', name: 'list_tables', title: '列出表', description: '列出当前 schema 下的表与视图', inputSchema: { type: 'object', properties: {} }, risk: 'read' },
      { kind: 'tool', name: 'describe_table', title: '看表结构', description: '列名、类型、是否可空、主键', inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] }, risk: 'read' },
      { kind: 'tool', name: 'query', title: '只读查询', description: '执行一条只读 SQL（SELECT / WITH / EXPLAIN / SHOW），最多返回 N 行', inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] }, risk: 'read' },
    ]
  }

  async invoke(rt: ConnectorRuntime, name: string, args: unknown): Promise<unknown> {
    const pool = await this.poolOf(rt)                   // 每实例一个小池（max 2）
    switch (name) {
      case 'list_tables':  return this.listTables(pool, rt)
      case 'describe_table': return this.describe(pool, rt, z.object({ table: z.string() }).parse(args).table)
      case 'query': {
        const { sql } = z.object({ sql: z.string().min(1) }).parse(args)
        assertReadOnlySql(sql)                            // 见下：只放行白名单、单条语句
        return this.runReadOnly(pool, rt, sql)            // 只读事务 + 超时 + 行数上限
      }
      default: throw new Error(`未知工具：${name}`)
    }
  }
}

/** 只放行 SELECT / WITH / EXPLAIN / SHOW / DESCRIBE；拒多语句 */
export const assertReadOnlySql = (sql: string): void => {
  const stripped = stripSqlCommentsAndStrings(sql).trim().replace(/;\s*$/, '')
  if (stripped.includes(';')) throw new ToolDeniedError('invalid-input', '只允许单条语句')
  if (!/^(select|with|explain|show|describe|desc)\b/i.test(stripped)) {
    throw new ToolDeniedError('invalid-input', '只允许只读查询（SELECT / WITH / EXPLAIN / SHOW）')
  }
}
```

`runReadOnly` 的三道锁：`BEGIN TRANSACTION READ ONLY`（PG 用 `BEGIN READ ONLY`）+ `statement_timeout` + 结果行数上限；连接账号本身也必须是只读低权账号（写进文档，代码兜不住超级用户函数）。

### 5.4 同步：从远端能力到工具行

```ts
@Injectable()
export class ConnectorSyncService {
  async sync(connectorId: string): Promise<SyncResult> {
    const inst = await this.repo.getOrThrow(connectorId)
    const driver = this.drivers.get(inst.driver)

    try {
      const caps = await driver.describe(this.runtime(inst))
      const tools = caps.filter((c) => c.kind === 'tool')
      const specs = tools.map((t) => toToolSpec(inst, driver, t))   // 见 5.5
      await this.skills.install(caps.filter((c) => c.kind === 'skill-pack'), inst)

      await this.db.transaction(async (tx) => {
        for (const spec of specs) await this.tools.upsertConnectorTool(tx, inst, spec)
        await this.tools.disableMissing(tx, inst, specs.map(s => s.key))
      })

      this.registry.registerDynamic(inst.id, specs)
      await this.repo.markOk(inst.id, specs.length)

      return { ok: true, count: specs.length }
    } catch (error) {
      this.registry.removeDynamic(inst.id)              // 失败就别留着旧工具
      await this.repo.markError(inst.id, redact(error)) // 脱敏后再落库
      return { ok: false, message: '同步失败，已摘掉这家服务的工具' }
    }
  }
}
```

### 5.5 一个远端工具 → 一个 ToolSpec

```ts
export const toToolSpec = (
  inst: ConnectorInstance,
  driver: ConnectorDriver,
  cap: Extract<Capability, { kind: 'tool' }>,
): ToolSpec => ({
  key: toolKeyOf(inst.key, cap.name),         // c-<实例>-<工具名>，≤64
  title: cap.title,
  // 说明要带纪律：外部内容当数据看
  description: `【连接器：${inst.name}】${truncate(cap.description, 900)}`,
  category: 'connector',
  params: cap.inputSchema
    ? safeFromJsonSchema(cap.inputSchema)     // zod 4 的 z.fromJSONSchema，转不动就降级
    : z.record(z.unknown()),
  config: z.object({}).default({}),            // 配置在连接器行上，工具行不再重复
  secretFields: driver.secrets,                // 脱敏按它走
  events: [],
  async exec(input, ctx) {
    return driver.invoke(runtimeOf(inst), cap.name, input)
  },
})
```

### 5.6 注册机加动态段

```ts
class ToolRegistry {
  private static = new Map<string, Entry>()
  private dynamic = new Map<string, Entry>()
  private listeners = new Set<() => void>()

  registerDynamic(connectorId: string, specs: ToolSpec[]): void {
    for (const spec of specs) {
      if (this.static.has(spec.key) || this.dynamic.has(spec.key)) {
        throw new Error(`工具 key 冲突：${spec.key}`)   // 记 error，不炸进程
      }
      this.dynamic.set(spec.key, { spec, tool: this.gateway.wrap(spec) })
    }
    this.emitChange()
  }

  removeDynamic(connectorId: string): void { /* 按 connectorId 摘掉，emitChange */ }

  /** 种子同步只喂这一段 */
  staticSpecs(): ToolSpec[] { return [...this.static.values()].map(e => e.spec) }
  /** agent 装配用全部 */
  specs(): ToolSpec[] {
    return [...this.static.values(), ...this.dynamic.values()].map((e) => e.spec)
  }
}
```

### 5.7 动态工具面（不重建 agent）

```ts
// ai.mastra.ts：tools 改成 resolver，请求时现取
const createMastraAgent = (definition: AgentDefinition) => new Agent({
  id: definition.key,
  instructions: ({ requestContext }) => envelopeOf(requestContext)?.systemPrompt ?? definition.instructions,
  model: modelFromEnvelope(...),
  tools: ({ requestContext }) => {
    const caller = callerOf(requestContext)
    const keys = definition.tools.includes(ALL_TOOLS)
      ? registry.keysFor(caller)              // 展开：此刻注册机里对这个人可用的全部 key
      : definition.tools
    return toMastraTools(registry.toolbox(keys), definition.key)   // 内部按注册机版本号缓存
  },
  skills: [...(await resolveSkills(definition.skills))],          // 技能也可以走 resolver
})
```

要点：

- **注册机不需要通知谁**，工具每次请求现取；连接器同步完，下一次请求就有。
- `toMastraTools` 的结果按"注册机版本号 + 工具 key 集合"缓存，避免每请求重复转换。
- 提示词里的工具清单仍是会话首轮快照；老会话只差"文字描述"，工具本身可用。

### 5.8 一次工具调用（网关一行没改）

```ts
// 模型调 c-wecom-bot-send
ToolGateway.invoke(spec, rawInput, call)
  → 读配置（库 + 默认值 + env 上限夹紧）
  → enabled / scope / rate-limit / validate / precheck 插件依次跑
       precheck：连接器停用 → 'disabled'；密钥缺失 → 'precheck-failed'
  → spec.exec(input, ctx)  →  driver.invoke(...)
       连不上 / 超时 / 协议错 → 抛 UpstreamError → 结论 'upstream'
  → redact（按 secretFields 把密钥换成提示串）
  → paginate（大结果分页）
  → audit（落时间线）
```

### 5.9 主体层 OAuth（二期）

```ts
// 1) 发起
async beginAuth(connectorId: string, userId: string) {
  const state = randomToken(24)
  const { verifier, challenge } = pkce()
  await this.redis.setJson(`oauth:${state}`, { connectorId, userId, verifier }, { ttlSec: 600 })
  return {
    url: authorizeUrl({ clientId, redirectUri /* 固定值 */, state, challenge, scope }),
  }
}

// 2) 回调
async handleCallback(code: string, state: string) {
  const session = await this.redis.take(`oauth:${state}`)   // 取一次就删
  if (!session) return renderHtml('授权已过期，请重新发起')
  const token = await exchangeCode({ code, verifier: session.verifier })  // 服务端换
  await this.tokens.save(session.connectorId, session.userId, encrypt(token))
  return redirect('/main/ai/connectors?authorized=1')
}
```

### 5.10 后台接口（一次看清全貌）

```
GET    /connector/catalog                型号列表（含字段声明）
GET    /connector/list                   实例列表（含状态、工具数）
POST   /connector/create                 新建
PATCH  /connector/update                 改配置 / 开关
POST   /connector/test                   测试连接（不落状态）
POST   /connector/sync                   同步工具
GET    /connector/:id/tools              工具清单（只读）
DELETE /connector/:id                    删除（工具行保留、置不可用）
GET    /connector/authorize/:id          固定入口：现生成 state 再跳厂商（提示词里就写它）
GET    /connector/oauth/callback         二期：固定回调
```

### 5.11 网关插件：connector-guard

```ts
// core/tools/plugins/connector-guard.plugin.ts
// 位置：enabled 之后、exec 之前。只对 origin='connector' 的工具生效。
export const connectorGuardPlugin: ToolPlugin = {
  name: 'connector-guard',
  async check(ctx) {
    const inst = await connectors.byToolKey(ctx.toolKey)      // 走缓存，命中不查库
    if (!inst) return null                                     // 代码工具，放行
    const state = await connectors.stateFor(inst.id, ctx.caller?.userId)
    if (state.ok) return null
    return {
      ok: false,
      reason: 'precheck-failed',
      message: `${inst.name}：${state.label}`,                 // 「尚未授权」「未配置访问令牌」…
      hint: state.kind === 'authorize'
        ? `把 ${publicBaseUrl()}/connector/authorize/${inst.id} 给用户，让他点开完成授权`
        : '请在后台「AI → 连接器」补全配置后再试',
      retryable: false,
    }
  },
}
```

插件链顺序变成：

```ts
[enabled, scope, connectorGuard, rateLimit, validate, precheck, ...]
```

之所以放在 `enabled` 之后：连接器停用是"这个能力不存在"，而 guard 管的是"能力在、但还没配好/没过期"，两者语义不同。

### 5.12 首轮注入（可选，默认关）

代码留在 `chat.service.ts` 的 `resolveSystemPrompt` 旁边（运行环境那段就在这），做成开关；内容只列"有问题且与本 agent 相关"的连接器，没问题就不输出。入口一律用固定地址 `/connector/authorize/:id`（点击时才生成 state），不要放带 state 的长链接。

### 5.13 `rest` 驱动：把一份配置变成工具

```ts
// 保存时校验（不通过就不让存）
export const RestConfig = z.object({
  baseUrl: z.string().url().max(255),
  headers: z.record(z.string()).default({}),          // 值里可含 {{secret.xxx}}
  timeoutMs: z.number().int().positive().default(15_000),
  tools: z.array(z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
    title: z.string().max(64),
    description: z.string().max(1000),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().startsWith('/'),
    params: z.record(z.unknown()).default({ type: 'object', properties: {} }),
    pathParams: z.array(z.string()).default([]),
    query: z.array(z.string()).default([]),
    body: z.array(z.string()).default([]),
    pick: z.string().optional(),
  })).min(1).max(50),
}).superRefine((cfg, ctx) => {
  for (const t of cfg.tools) {
    assertPathMatchesParams(t, ctx)      // {owner} 占位符必须有同名参数
    if (t.method === 'GET' && t.body.length > 0) ctx.addIssue({ code: 'custom', message: 'GET 不能带 body' })
  }
})

@Injectable()
export class RestDriver implements ConnectorDriver {
  kind = 'rest'
  transport = 'http' as const
  config = RestConfig
  secretFields = [{ key: 'token', secret: true }]

  async describe(rt: ConnectorRuntime): Promise<Capability[]> {
    // 不需要发现：工具全在配置里
    return rt.config.tools.map((t) => ({ kind: 'tool' as const, name: t.name, title: t.title, description: t.description, inputSchema: t.params, risk: t.method === 'GET' ? 'read' : 'write' }))
  }

  async probe(rt) {
    const first = rt.config.tools.find((t) => t.method === 'GET')
    if (!first) return { ok: true }      // 只有写接口时无法探活，交给第一次真实调用
    await this.invoke(rt, first.name, {})
    return { ok: true }
  }

  async invoke(rt: ConnectorRuntime, name: string, args: Record<string, unknown>) {
    const tool = rt.config.tools.find((t) => t.name === name)
    if (!tool) throw new Error(`未知工具：${name}`)

    // ① 路径占位符
    const path = tool.path.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(String(args[key])))
    // ② query
    const url = new URL(rt.config.baseUrl.replace(/\/+$/, '') + path)
    for (const key of tool.query) if (args[key] !== undefined) url.searchParams.set(key, String(args[key]))
    // ③ body
    const body = tool.body.length > 0 ? Object.fromEntries(tool.body.map((k) => [k, args[k]])) : undefined
    // ④ 请求头（只允许 {{secret.x}}）
    const headers = Object.fromEntries(
      Object.entries(rt.config.headers).map(([k, v]) => [k, v.replace(/\{\{secret\.(\w+)\}\}/g, (_, n) => rt.secrets[n] ?? '')]),
    )

    const res = await fetchGuarded(url.toString(), {
      method: tool.method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: rt.config.timeoutMs,
      maxBytes: 2 * 1024 * 1024,
    })
    if (!res.ok) throw new UpstreamError(`上游返回 HTTP ${res.status}`)

    const json = parseJsonOrText(res.text)
    return tool.pick ? pickPath(json, tool.pick) : json
  }
}
```

三个细节都写死在驱动里、配置改不了：**不允许完整 URL**（防换 host）、**只认 `{{secret.x}}`**（防任意模板）、**不解析响应里的表达式**（`pick` 只支持点路径）。

### 5.14 `cli` 驱动：装、配、授权、执行

```ts
// 子命令白名单写死在驱动里（页面改不了），避免变成任意命令执行
const LARK_ALLOWED = ['im', 'docs', 'base', 'calendar', 'minutes', 'mail', 'task', 'wiki', 'contact']

@Injectable()
export class LarkCliDriver implements ConnectorDriver {
  kind = 'lark-cli'
  transport = 'none' as const
  config = z.object({ profile: z.string().default('default'), timeoutMs: z.number().int().positive().default(30_000) })
  secretFields = [{ key: 'appSecret', secret: true }]

  /** 一个连接器交出一个工具 + 一份技能文档 */
  async describe(): Promise<Capability[]> {
    return [
      {
        kind: 'tool',
        name: 'run',
        title: '执行飞书命令',
        description: '按技能文档给出的命令执行 lark-cli（不含 lark-cli 本身、不走 shell）。先读对应技能确认参数。',
        inputSchema: {
          type: 'object',
          properties: {
            args: { type: 'array', items: { type: 'string' }, description: '子命令与参数，如 ["im","send-message","--chat-id","...","--text","..."]' },
          },
          required: ['args'],
        },
        risk: 'write',
      },
      { kind: 'skill-pack', dir: LARK_SKILLS_DIR, name: '飞书 CLI', description: '17 个业务域的命令用法、参数与常见错误' },
    ]
  }

  async invoke(rt: ConnectorRuntime, name: string, input: unknown) {
    if (name !== 'run') throw new Error(`未知工具：${name}`)
    const { args } = z.object({ args: z.array(z.string().max(2048)).min(1).max(32) }).parse(input)

    if (!LARK_ALLOWED.includes(args[0])) {
      throw new ToolDeniedError('invalid-input', `不允许的子命令：${args[0]}`, `只允许：${LARK_ALLOWED.join(' / ')}`)
    }
    if (args.some((a) => /[|;&$`<>]/.test(a))) {
      throw new ToolDeniedError('invalid-input', '参数里不允许出现 shell 符号')   // execFile 不走 shell，但先挡一道
    }

    const { stdout, stderr } = await execFileP('lark-cli', ['--profile', rt.config.profile, ...args], {
      timeout: rt.config.timeoutMs,
      env: { ...process.env, LARK_APP_ID: String(rt.config.appId), LARK_APP_SECRET: rt.secrets.appSecret },
      maxBuffer: 2 * 1024 * 1024,
    })
    return { stdout: stdout.trim(), stderr: stderr.trim() }
  }

  /** 状态 = auth status 的输出 */
  async probe(rt) {
    try {
      const { stdout } = await execFileP('lark-cli', ['--profile', rt.config.profile, 'auth', 'status'], { timeout: 5_000 })
      const parsed = parseAuthStatus(stdout)          // { authorized: boolean, user?: string }
      return { ok: parsed.authorized, message: parsed.authorized ? `已授权：${parsed.user}` : '尚未授权' }
    } catch (error) {
      return { ok: false, message: 'CLI 未安装或不可执行' }
    }
  }
}
```

配套的运维接口（都在后台）：

```
POST /connector/cli/install     异步跑 npm i -g，回报版本与路径
POST /connector/cli/init        写 profile（appId / appSecret）
POST /connector/cli/login       拉起 auth login，拿回授权链接；轮询 auth status
GET  /connector/cli/status      版本、路径、授权人、过期时间
```

技能包的安装：连接器创建 / 启用时，把驱动内嵌的技能目录写到 `<skills dir>/connectors/<key>/`；停用或删除时整目录删掉。目录带一个 `.managed-by-connector` 标记，避免误删用户自己放的技能。

---

## 6. 附

### 6.1 参考实现：Octop（2026-11-07 读）

腾讯云开源的同类产品（Python），连接器模块在 `src/octop/infra/connectors/`。它的做法：目录是 `catalog.json`（30 条），实例表 `connectors`（一人一条、凭证 Fernet 加密、带过期时间），出口统一成 MCP（`remote` 直连 / `gateway` 进程内假 MCP / `internal` 自托管），OAuth 用 DCR + PKCE，`state` 落库一次性，回调固定，非 loopback 强制 HTTPS，工具面有 `allowed_tools` 白名单与按指纹缓存。

**要学的**：目录/实例分离、凭证字段是元数据不是黑盒、OAuth 那五个坑。
**不学的**：把 MCP 当唯一出口（它的 agent 框架没有工具治理层，我们有）、按用户建实例（我们是管理员配一次全员用）、包厂商 CLI（部署被绑死）。

一句话：**它把一切收敛成 MCP，我们把一切收敛成工具。**

### 6.2 已定

| # | 事 | 结论 |
| --- | --- | --- |
| 1 | MCP 客户端 | **用官方 SDK**（`@modelcontextprotocol/sdk`），外面包一层 `McpTransport` |
| 2 | 凭证存法 | **不加密**，沿用明文口径（2026-10-01）；接口只回提示串、日志与出参脱敏 |
| 3 | 未配置 / 过期 | **网关插件 `connector-guard`** 拦一道，返回可纠正的结论；首轮注入做成开关，默认关 |
| 4 | 本地 MCP 进程 | **不做 stdio**；只接 HTTP（MCP / REST）与数据库；省掉进程池、pidfile、孤儿回收 |
| 5 | 第一批 | **数据库**：PostgreSQL → MySQL → Redis |
| 6 | 工具面 | **不重建 agent**：Mastra 的 `tools` 支持按请求解析，注册机动态注册即可；提示词里的清单只是老会话缺描述 |
| 7 | 工具太多 | **两级**：按连接器选本次带哪些（默认开 + 显式选）+ 连接器内 `allowed_tools` 白名单；不做 RAG（§3.12） |
| 8 | MCP 的定位 | **只当远端地址 + 请求头**：不托管服务器、不维护会话状态、不做心跳巡检；状态只记上次测试结果（§3.7） |
| 9 | 状态字段 | `status` 只表示上次测试结论；不做 `starting/ready/closing` 那套连接状态 |
| 10 | 自定义非 MCP | 三条路：**`rest` 声明式**（主力，不写代码）→ 新写驱动（私有协议）→ 不自定义（先看有没有现成驱动 / 该不该用 MCP）；声明里不做脚本、不做任意模板（§3.13） |

### 6.3 还剩两件

| # | 问题 | 大白话 | 建议 |
| --- | --- | --- | --- |
| 1 | **主体层排期** | 飞书用户授权（授权链接 + SSO + 回调 + 按用户 token）排第几批 | 二期。第一批数据库三步已经排满；主体层要新增回调路由、按用户 token 表、按用户状态与审计 |
| 2 | **多副本状态** | 起两个 server 进程时，`ai_connectors.status` 只有一行，谁最后写算谁，页面看到的是"某台机器的情况" | 一期单实例 + 页面文案说明；要多副本再上按实例的状态表 |
| 3 | **`lark-cli` 走哪条路** | 它是"命令行 + 一堆技能文档"，不是工具（§3.14） | **已落地样板（2026-11-09，见 §8）**；`rest` 接飞书高频接口作为对照仍可后续补 |

---

## 7. 实施记录（一期，2026-11-08）

已落地（后端纵切，PG 一条通路）：

| 层 | 内容 |
| --- | --- |
| 数据结构 | `ai_connectors` 表 + `ai_tools` 三列（`origin` / `connector_id` / `remote_tool_name`）；迁移 `1794000000000-AiConnector`，已在本机执行 |
| 字典 / 数据结构 | `ConnectorStatus` / `ConnectorKind` / `ConnectorTransport` / `ConnectorAuthBase` / `ConnectorAuthSubject` / `ToolOrigin`；`ToolCategory` 加 `connector`、`ToolDenyReason` 加 `upstream`；错误码 3409–3411 |
| 抽象 | `connector.types.ts`（`Capability` + 六成员驱动）、`connector.catalog.ts`（内置型号）、`connector.tool.factory.ts`（能力 → ToolSpec） |
| 驱动 | `sql`（PostgreSQL / MySQL）：`list_tables` / `describe_table` / `query`；`redis`：`scan_keys` / `get` / `hgetall`；三道闸（账号只读、只读 SQL / 键前缀、只读事务 + 超时 + 行数上限） |
| 注册机 | 静态段 + 动态段（`registerDynamic` / `removeDynamic` / `expand` / `version`）；种子同步只喂 `staticSpecs()` |
| 工具面 | `ai.mastra.ts` 的 `tools` 改成按请求解析；`assistantAgent` 授权清单加 `ALL_TOOLS` |
| 网关 | `connector-guard` 插件（实例停用 → `disabled`；缺密钥 → `precheck-failed`），在 `enabled` 之后 |
| 接口 | `/ai-connector/catalog` / `list` / `create` / `update` / `detail` / `test` / `sync` / `remove`（全部 POST + 管理员鉴权） |
| SDK | `client.aiConnector.*` 八个方法 |
| 后台页 | `/main/ai/connectors`：列表、型号卡片、新建 / 编辑（字段由目录声明驱动）、测试 / 同步 / 启停 / 删除；已进左侧菜单 |

验证：`pnpm typecheck`、`check:inject`、`check:mastra`、`check:ui` 通过；新增 10 条单测；注册机标准测试集 17 条、启动冒烟 2 条通过；PG 与 Redis 驱动对真实服务实测（PG 列出 18 张表、写语句被拦；Redis 扫键 / 读串 / 读哈希正常、越界键被拦、probe 正常）。**MySQL 驱动已实现但本机没有实例，未做连通实测。**

未做（按计划排后面）：

- `rest` / `mcp-http` 驱动与自定义连接器；
- 授权链接（主体层）与首轮注入提醒；
- `allowed_tools` 的页面配置（列已建、同步时已生效）。

**2026-11-09 修的一个真坑**：MySQL 型号建出来时 `config` 里没有 `dialect`，驱动默认按
PostgreSQL 连 3306，报 `received invalid response: 4a`（PG 协议收到的不是 PG 的应答）。
根因是"型号只声明了表单字段，没声明驱动默认值"。修法：目录加 `defaults`（`dialect` / 默认端口），
服务端在 `create` / `update` 时先合并再交给驱动解析——API 直连与页面创建都覆盖。

**2026-11-09 修的第二个坑**：模型调用连接器工具时报「缺少密码」，但连接器页面上明明配了。
根因是密钥放错了层——`precheck` 按**工具设置**里的密钥判空，而连接器密钥在**实例**上，
工具行里当然没有。修法：`connector-guard` 把实例密钥"嫁接"进本次调用的 `settings.secret` /
`secretHint`，于是前置检查不再误报、出参也按真实值脱敏（顺带补上了原来记的那个脱敏口子）。
工具配置页也不再对连接器工具展示密钥字段（避免让人以为要重复填一遍）。

已知问题（记在这里，别忘）：

- ~~`redact` 插件按工具行密钥脱敏，而连接器密钥在实例上~~ —— **已修**（见上，guard 嫁接）；
- 连接器停用后，`ai_tools` 里的行仍是 `enabled=true`，靠 `connector-guard` 在调用时拦——
  页面列表若按"工具行开关"展示会显示成"开着"，需要在详情里说明这一点。

---

## 8. 实施记录（lark-cli 样板，2026-11-09）

按 §3.14 落地"命令行 + 内嵌技能"的连接器样板，只做一个型号 `lark-cli`：

| 层 | 内容 |
| --- | --- |
| 目录 | `connector.catalog.ts` 加 `LARK_CLI_CATALOG`（`driver=lark-cli`、`transport=process`、`category=office`）；字段 `appId` / `appSecret` / `brand` / `identity`，`defaults` 给 `brand=feishu` / `identity=auto` |
| 驱动 | `drivers/lark-cli.driver.ts`：`describe` 只交一个 `run` 工具；`invoke` 用 `spawn` 直传参数数组（不走 shell；`detached` 进程组，超时 / 取消按组杀，避免留下 Go 孤儿）；`probe` 跑 `doctor`；`dispose` 删实例 HOME |
| 白名单 | `drivers/lark-cli.policy.ts`（纯函数）：业务域 20 个 + `schema` / `whoami` + `skills list|read` + `auth status|list|login|scopes|check`；禁 `api` / `config` / `profile` / `update` / `apps` / `event` / `auth logout`，禁 `--profile` / `--yes` |
| 凭证 | App ID / Secret 来自连接器实例；每实例独立 `HOME=~/.billy/lark-cli/<id>`，首次调用跑 `config init --app-id ... --app-secret-stdin --force-init`，指纹（sha256）没变不重跑；状态文件只存指纹与 appId / brand，不存 secret |
| 环境隔离 | 子进程只拿 `PATH` / `HOME` / locale / 代理 / CA 白名单，不带服务端密钥；`cwd` 固定在实例 HOME |
| 镜像 | `docker/Dockerfile.server` 的 runner 阶段 `npm i -g @larksuite/cli@1.0.99`（`ARG LARK_CLI_VERSION`，默认 npmjs，可用 `NPM_REGISTRY` 覆盖）；`docker-compose.yaml` 挂 `lark-cli-data:/home/appuser/.billy` |
| 测试 | `test/ai-connector.test.ts` 新增 6 条：目录 / 配置默认值 / 能力面 / 白名单放行 / 白名单拒绝 / `auth login` 非阻塞 |
| 文档 | 本文件 §3.14 / §6.3 / §8；`docs/design/ai-extension-guide.md` §3；skill `develop-ai-agent` §9 |

验证：server / admin 全量 `typecheck`、`check:inject` / `check:mastra` / `check:ui` 通过；连接器单测 21 条通过；
用真实 `@larksuite/cli@1.0.99`（macOS arm64）实测 `skills list` 返回 28 份技能、`skills read lark-im` 返回 24KB Markdown、
假凭证下 `doctor` 正确报"应用不存在"；用假 CLI 实测 `probe` / `run` / 错误信封 / 超时 / 取消 / 输出超限 / `dispose` 全链路。

已知边界：用户 token 落在实例 HOME（容器不挂卷重启即丢；删连接器只删本地，不撤销飞书侧授权）；多副本不共享授权（与 §6.3 同源）；命令以**服务进程身份**执行，能读该身份可读的文件（白名单挡的是命令面，不是文件系统沙箱；要强隔离得把连接器放进独立容器 / 用户，本期不做）；
`lark-cli` 版本升级可能改命令与技能文档，升级要同步 `LARK_CLI_VERSION` 并回归白名单。
