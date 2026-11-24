# AI 能力

> 产品里的 AI 怎么跑（会话 / 流式 / 工具 / 恢复 / 用量），以及工程怎么让 AI 参与开发。
> 扩展步骤见 [ai-extension-guide](../design/ai-extension-guide.md) 与 `develop-ai-agent` skill。

## 运行时与接口

模板自带一套能上生产的 AI 对话。现在按运行面 / 控制面拆成 **6 个 Nest 服务**（另有两个 Next 前端，只连 main）：

- **main（9989，公网 API / 控制面）**：控制面——鉴权、业务 CRUD、全部 AI 配置 / 管理 HTTP，以及 `/agent/*` 的入口与
  SSE 中继；**不跑 agent loop**。
- **agent-runtime（9990，只给 main 调）**：只跑 agent loop——agents / 会话编排 / 工具面装配 / 提示词 /
  技能加载 / 子 agent / run 队列 / 恢复；对外只暴露 `/internal/agent/*` 与探针。
- **model-gateway（9992，内网）**：模型网关——canonical OpenAI 协议、四套上游适配、模型目录、上游 Key 池、
  用量落库；**runtime 不持供应商 key**。
- **capability-gateway（9993，内网）**：能力目录权威——服务登记 / 心跳 / 目录 / 授权过滤 / 调用路由 / 限流 /
  MCP client / 工具审计，以及内建 `wait-task` / `cancel-task` / `tool-search`；**不执行能力**。
- **common-capability（9994，内网）**：通用能力执行，登记服务 `common`（9 个能力）。
- **workspace-service（9995，内网）**：工作区执行面，登记服务 `workspace`（8 个能力）——`bash` 与工作区文件。

后台的 AI 管理面（模型管理 / 网关用量 / 上游 Key / 技能库 / AI 市场 / 记忆 / 文件管理 / 工作区 / 凭据管理 /
能力服务 / 审计与复盘）+ **会话工作台** + **技能编辑器**（画布）；授权不单独占页：服务授权在「能力服务」里勾选
外部服务后点「授权」，技能授权在「技能库」里勾选后点「授权」。旧入口 `/main/ai/tools`、`/main/ai/authorizations`
与 `/main/ai/skills/grants` 都保留重定向；`/main/ai/chat` 只是跳到新会话地址。

前端只连 main；接口分两类前缀——`/agent/*`（会话 / 运行 / 文件 / 用量）与 `/ai-*`（后台配置）。
需要 agent loop 的请求（对话 / 续跑 / 停止 / 重连 / 快照 / 目录）由 main 校验身份后转发给 runtime 的内部接口
（`/internal/agent/*`，带内部令牌）；会话、运行记录、时间线与文件列表由 main 直接读写库。runtime 的模型输出经
Redis pub/sub 定向频道（`agent:stream:client:<clientId>`）回到 main 的 SSE。`/agent/chat/stream` 先 attach
SSE 再 fetch runtime，runtime 那侧的 SSE body 只 drain 维持背压，内容全部走 pub/sub——断线重连与背压互不影响。

```text
POST /agent/chat                非流式对话（跑完才返回）
POST /agent/chat/stream         流式对话（SSE；输出经 Redis pub/sub 回 main 的 SSE）
POST /agent/chat/resume         回答挂起中的一轮（ask-user-questions 之后续跑；不是断线续传）
POST /agent/run/stop            停止某一轮（main 转发 runtime，由 runtime abort）
GET  /agent/run/stream          重连当前运行（EventSource 只能 GET；runtime 从 Redis 按 sinceRev 补发）
GET  /agent/run/snapshot        当前运行快照
GET  /agent/run/:runId/stream   重连指定运行
GET  /agent/run/:runId/snapshot 指定运行快照
POST /agent/queue/list|update|remove  用户的排队项（只读 / 改 / 删 queued）
POST /agent/conversation/*      会话增删改查（含 file-access 切换文件权限；main 直接读写库）
POST /agent/run/list|detail     运行列表 / 详情（审计与复盘；main 读库）
POST /agent/timeline/list       会话时间线（main 读库）
POST /agent/file/*              会话工作区文件 / 预览 / 后台跨会话列表与统计（main）
GET  /agent/file/workspace-content  按 cookie 读工作区文件（Range / 下载；main）
POST /agent/status|list|instructions|models  agent 目录与系统指令代理（main，30s 缓存）
POST /agent/usage/summary|rollup    逐轮 tokens 汇总（main）
POST /agent/usage/gateway/list|summary|reconcile  网关用量（model_gateway_usage）

POST /ai-model/provider/*|model/*|provider-key/*  供应商 / 模型 / 上游 Key
POST /ai-tool/*                 运行时工具的开关 / 限额 / 配置 / 凭据
POST /ai-capability/*           能力服务登记 / 探活 / 拉 MCP 清单 / 服务授权（grants/list、grants/set）
POST /ai-skill/* · /ai-memory/* · /ai-workspace/*  技能库 / 长期记忆 / 工作区
```

**运行时能力**

- **会话与运行**：`conversations` / `runs` / `timelines` 三张表；运行中进度放 Redis，跑完落 Postgres；
  刷新页面能接着看（快照 + `sinceRev`），服务重启后在跑的会话由 durable 恢复与看门狗兜底。
- **流式与续传**：帧是 AG-UI 1.0（schema 版本 2），文本、推理、工具调用、步骤、来源、子 agent 过程全细节推送；
  收尾是 `RUN_FINISHED`，不再写 `[DONE]`（`?protocol=ai` 才逆映射旧格式并补 `[DONE]`）。断线由 runtime 从
  Redis（`agent:run:<runId>` 进度 Hash、`agent:stream:<runId>` 输出 List）按 `sinceRev` 补发。
- **工具面**：本地编排工具一条 `@ToolDecl`（`@ToolGroup` 类 + 方法即工具），服务能力一条
  `@CapabilityDecl`（执行在服务侧）。本地工具走 `ToolGateway` 插件链，顺序固定
  `Enabled → Scope → RateLimit → Validate → Precheck → AuditStart → Redact → AuditEnd`；服务能力经能力
  网关执行，治理（开关 / 限额 / 入参校验）与审计在网关侧。工具面共 **35 个 key**：
  - **本地编排 15**：规划 4（`plan-create` / `plan-reorder` / `plan-complete` / `plan-delete`）、
    子 agent 4（`run-sub-agent` + `sub-agent-list` / `wait-sub-agent` / `cancel-sub-agent`）、
    技能库 7（`skill-list` / `skill-save` / `skill-file-save` / `skill-file-append` / `skill-import` /
    `skill-delete` / `skill-enable`）；
  - **能力服务 17**：common 9（`memory-save` / `memory-search` / `memory-forget`、`web-search` / `web-fetch` /
    `web-request`、`read-tool-result`、`file-submit` / `file-download`）+ workspace 8（`bash` +
    `file-list` / `read-file` / `write-file` / `append-file` / `replace-file` / `file-search` / `workspace-files`）；
  - **网关内建 3**：`wait-task` / `cancel-task` / `tool-search`（进程内处理，不转发；长任务受理后用前者拿结果或叫停）。

  另有 3 个 Mastra 运行时自带、不进注册机的工具（`skill` / `skill_search` / `skill_read`，由 Mastra 按技能
  配置自行挂载，不在我们的配置与审计链里），不计入 35。工具的可变部分入库 `ai_tools`（enabled / limits /
  config / secrets），启动对账只补不覆盖人工改动；元数据（title / description / 参数 schema）不由 main 存快照
  ——内建工具问 runtime 的 `/internal/agent/tools`，服务能力问网关 `/v1/capabilities/list`，main 侧 5s 缓存、
  任一侧不可用只降级。
- **能力目录与发现**：runtime 每 5s 从网关 `/v1/capabilities/list` 取目录（按身份缓存，网关不可用时 fail-open
  返回空，不影响本地工具）。`source=code` 的能力（内置三服务）**随工具面下发**，与本地注册机 key 去重；
  `source=manual`（MCP / 手工登记的外部服务）**不下发**——模型先用 `tool-search` 检索（BM25，只搜当前身份
  可见目录），命中 key 记进 Redis（`ai:tool:discovered:<conversationId>`，TTL 7 天、每会话最多 50 个），
  **下一轮**才补进工具面。网关做的是 **HTTP 型 MCP client（不支持 stdio）**，MCP 工具名归一成扁平 key。
  子 agent 不含外部服务。
- **授权**：agent 的授权清单只写具体 key 或 `'*'`（`ALL_TOOLS`），没有类别 / 外部工具选择器。装配期按调用
  身份过滤 `scope`（`all` / `admin` / `user` / `agent` + `allowedAgents`），没授权的工具**根本不会出现在
  模型面前**；`scope` / `allowedAgents` 由代码声明给出，后台只读展示、不提供修改。服务级授权
  `ai_service_grants` 只作用于 `source=manual` 的外部服务；`source=code` 的内置服务默认全部可用。
- **执行位置**（本版最大的变化）：`bash` 与工作区文件 7 个 → **workspace-service**；`memory-*` / `web-*` /
  `read-tool-result` / `file-submit` / `file-download` → **common-capability**；`wait-task` / `cancel-task` /
  `tool-search` → **网关进程内**。runtime 只做编排与装配，不再持 bash / 联网 / 文件 / 记忆执行体。
- **工作区隔离**：文件权限三档 `read-only` / `workspace-write` / `danger-full-access`（定义在 kits），
  会话只能选前两档（会话级 `file_access` 目前只进 runtime 的执行信封，尚未随能力调用下发到执行面，
  见后端文档「已知缺口」）；部署默认 `AGENT_WORKSPACE_SANDBOX=true`——沙箱不可用就**拒绝执行（fail closed）**，
  只有自托管单租户显式设 `off` 才放开宿主执行。执行后端 `local`（kits 沙箱）/ `container`（docker 或
  k8s Pod）/ `microvm`（预留）；容器名 `billy-ws-<workspaceId>`，镜像 `billy-workspace:2026.11.1`，
  空闲默认 2h 回收；`GET /info` 暴露部署模式与会话可选的文件权限。
- **技能库**（库 / 落盘分裂在两个服务：main 的 `ai-admin/skill` 写库，runtime 的 `ai/skills` 落盘并加载）：
  后台「AI → 技能库」在线写技能（类 Notion 的块编辑器写正文 + `references/` / `scripts/`），也能贴
  skills.sh / GitHub 链接把技能**下载进库**；启停立即生效、不用重启。DB 是事实源，服务端落盘到
  `~/.billy/skills`（`AGENT_SKILLS_LIBRARY_DIR`）供 Mastra 按需读；变更经 Redis EventBus `ai.skill.changed`
  通知，漏事件由启动全量同步兜底。agent 也能用 `skill-save` 等 7 个工具自己建技能（scope `admin`），
  写入入口只有管理员（技能内容会进入模型上下文）。模型侧提示词要求**先扫技能清单**：有匹配的就先
  `skill` 加载再动手；设计 / 页面 / 报告类任务先加载设计类技能再写第一版，不要等用户点名。
- **长期记忆**（读写与注入在 runtime 的 `ai/memory`，后台接口在 main 的 `/ai-memory/*`，service / repository
  已下沉 `@repo/ai-data`）：`ai_memories` 按用户存画像 / 偏好 / 事实 / 约束；agent 用 `memory-save` /
  `memory-search` / `memory-forget` 读写（身份取运行时信封，子 agent 不可用），后台「AI → 记忆」可查看 /
  编辑 / 停用 / 删除。每轮按置顶 + 最近使用注入 system 消息（≤20 条、≤800 token），注入了哪些 id 写进
  `request_snapshot`；短期 thread 用 `@mastra/redis` 落 Redis，重启 / 多副本不丢。
- **文件管理**（HTTP 在 main 的 `ai-admin/file`，执行在 workspace-service / common-capability）：
  `ai_files` + 对象存储 + 会话工作区文件树；文件类能力全部过同一套网关，后台「AI → 文件管理」跨会话
  列表 / 预览 / 分享（总量统计在控制台）；Office 前端直连对象存储，S3 / COS 需配 CORS。管理员还能给文件
  生成**免授权分享链接**（`/s/{token}`，有效期可选、明文 token 只显示一次、可撤销，OSS 地址不进浏览器）。
- **运行控制**：run 队列（每会话 dispatch 锁 15s、上限 50，runtime 每秒 tick 原子领取；`/agent/queue/*`
  让用户只读 / 改 / 删自己的 queued 项）；动态子 agent **始终异步**（提示词由主 agent 现场写，结论落工作区
  `subagents/<名字>-<子 runId>.md`，完成后唤醒父 run；`wait-sub-agent` / `cancel-sub-agent` 取结果或取消）；
  `ask-user-questions` 是 Mastra 原生工具（挂主 agent，可挂起 / 续跑）。
- **多模态附件**：图片与 PDF 走对象存储，只传 key；附件 key 做归属校验，不能越权读他人文件。
- **上下文**：达到模型窗口 70% 触发裁剪——先裁到 50%，仍装不下就压缩到 40%，再不行兜底（system + 最近 1 轮）；
  原文保留可回看。
- **模型与用量**：供应商表 + 模型表 + 上游 Key 在后台配（不用改环境变量）；runtime 经 model-gateway 的
  模型目录调模型（目录缓存 30s，**不持供应商 key、不读模型配置表**）。用量在网关落 `model_gateway_usage`
  （价格快照 + cost_micros），逐轮 tokens 仍落 `runs` 并按日 rollup，按模型 / 按 agent 汇总。
- **前端**：`@repo/ui` 内置 48 个 ai-elements，后台会话页开箱可用。

**配置位置**：

- 模型与供应商 →「AI → 模型管理」；上游 Key 池 →「AI → 上游 Key」（实际由 model-gateway 持有并调度）
- 模型网关的请求与花费 →「AI → 网关用量」
- 工具开关 / 限额 / 配置 / 凭据 →「AI → 能力服务」的「运行时工具」区块（本地编排工具与服务能力在同一处配，
  旧「工具配置」入口已并入）
- 外部服务登记 / MCP →「AI → 能力服务」；服务级授权 → 在同一页勾选外部服务后点「授权」（选管理员）
- 技能 →「AI → 技能库」；长期记忆 →「AI → 记忆」；文件 →「AI → 文件管理」；工作区 →「AI → 工作区」
- 调用回放与审计 →「AI → 审计与复盘」

设计细节与取舍见 [`docs/design/ai-agent.md`](../design/ai-agent.md)、
[`docs/design/ai-agent-tool-engine.md`](../design/ai-agent-tool-engine.md)、
[`docs/design/capability-protocol.md`](../design/capability-protocol.md)、
[`docs/design/service-authorization.md`](../design/service-authorization.md) 与
[`docs/design/workspace.md`](../design/workspace.md)。

## 定义自己的 agent

内置的 `assistant` 是**能力上限的示例**（工具面 `ALL_TOOLS`，技能 `ALL_SKILLS`）；产品里的 agent 应该按职责裁剪。
新增一个 agent = `agents/<名字>.agent.ts` 写一份 `AgentSpec` + `agents/index.ts` 登记一行 + 一个提示词模板，
不用改 core 的任何装配代码。

```ts
// apps/agent-runtime/src/modules/ai/agents/researcher.agent.ts
import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import type { AgentSpec } from './types.js'

export const researcherAgent: AgentSpec = {
  key: 'researcher',
  name: '资料助手',
  description: '查资料、读网页、整理结论；不执行命令',
  tools: [
    TOOL_KEYS.webFetch,          // 能力服务的 key 也直接写：执行在 common-capability
    TOOL_KEYS.webSearch,
    TOOL_KEYS.readToolResult,
  ],
  skills: [],                    // 只挂它要用的技能；没有就不挂，别写 ALL_SKILLS
  prompt: { template: 'researcher' },
}
```

```ts
// agents/index.ts
export const AGENT_SPECS: readonly AgentSpec[] = [assistantAgent, researcherAgent]
```

五条口径：

1. **工具写什么**：具体 key（从 `TOOL_KEYS` 取）或 `'*'`（全部可见工具，只给示例 agent）。
   没有类别 / `EXTERNAL_TOOLS` 这类选择器：来源（本进程编排 / 内置服务 / 外部服务）不属于授权语法。
2. **不给的就是不给**：不在清单里的工具不会出现在模型面前；不要用提示词写「不要用某工具」，
   那约束不住模型，授权能。子 agent 的工具面 = **父 agent 的授权面 ∩（全部 − 委派类 − `child: 'deny'`）**，
   能力目录里 `source=code` 的能力同样按这条规则补进去。
3. **外部服务由模型自己搜索**：MCP / 外部登记服务（`source=manual`）不随工具面下发；模型用 `tool-search`
   找到 key 后，runtime 记进会话（Redis，7 天 / 每会话 50 个），**下一轮**才补进工具面。子 agent 不含外部服务。
4. **作用域是第二层**：工具默认 `scope` 由代码声明给（数据库类、运维类默认 `admin`），`allowedAgents`
   同属声明，后台工具配置只展示、不提供修改。要给产品 agent 用，就在 agent 声明里授权具体 key
   （授权的就是作用域）；装配期再按调用身份过滤一遍，前台用户根本看不到管理员工具。外部服务的访问控制
   在「AI → 能力服务」的勾选 →「授权」。
5. **提示词里的工具清单是渲染出来的**：首轮由 `renderAgentInstructions` 渲染——本地注册机 `describe()` +
   目录里 `source=code` 的能力，落 `system` 快照后逐字复用；`/agent/instructions` 预览与对话首轮共用同一份，
   模板里不要手写工具名。

验证：启动不报错 → `POST /agent/list` 看这个 agent 的工具数 → `POST /agent/instructions` 核对提示词里的工具
清单 → 跑一轮后查审计 `runs.request_snapshot.toolKeys`（应当是**展开后的具体 key**，不是选择器）→ 分别用
管理员和前台用户身份各跑一次，确认作用域。

## Agent Skills（AI 原生开发）

工程把「怎么做」写进 skill：`.agents/skills/` 下每个 skill 是一个独立目录（标准 Agent Skills 格式，
`SKILL.md` 带 YAML frontmatter 的 `name` + `description`，大块内容拆到 `references/`），
AI 编码 Agent 按任务**按需加载**，工具无关（Claude Code / Codex / Cursor 等均可读取）。

- **最高准则**：[AGENTS.md](../../AGENTS.md)（8 条首要准则，先于一切 skill 与规范）；Claude Code 入口为
  [CLAUDE.md](../../CLAUDE.md)
- **必读入口**：`billy-dev-foundation`（分层架构、代码约定含「不重复造轮子」实现查找顺序、常用命令、标准流程）
- **共 28 个 skill**：必读 1（`billy-dev-foundation`）+ 功能 26（`define-data-structure` / `define-dict-enum` /
  `database` / `develop-business-module` / `develop-backend-api` / `develop-frontend-page` / `develop-ai-agent` /
  `ai-agent-engineering` / `implement-auth` / `object-storage` / `concurrency` / `kafka` / `scheduler` / `stream` /
  `telemetry` / `notification` / `lark` / `state-machine` / `write-tests` / `git-workflow` / `codegraph` /
  `getting-started` / `table-state` / `migrate-v8-to-v9` / `tsdown` / `code-quality`）+
  元 1（`manage-skills`）；完整索引见
  [`.agents/skills/README.md`](../../.agents/skills/README.md) 与
  [`billy-dev-foundation/references/catalog.md`](../../.agents/skills/billy-dev-foundation/references/catalog.md)
- **典型全链路**（`develop-business-module`）：数据结构（schema + 实体）→ 建表迁移 → 业务（repository /
  service）→ 接口（controller + 错误码）→ SDK → 前端页面
- **记忆**：[`.agents/memory/`](../../.agents/memory/README.md) 记「查过才知道的」——坑、链路地图、实测数字、
  定过的取舍。入口是索引表（约 55 条，每条一句话），命中主题再读卡片；卡片带「依据」「失效信号」与
  **查证优先级**（必核 / 抽核 / 免核：行号与库里的值用前必核，机制性结论免核），前提变了改旧卡。
  目的是同一个问题只调查一次，不必每次重新翻代码
- **维护**：新增 / 修改 skill 走 `manage-skills`（目录与 frontmatter 规范、references 拆分、索引注册）；
  **代码变更后须同步受影响的 skill 与文档**

## AI 使用配置

skill 是纯 Markdown，agent 接上就能读；下面是让 AI **真正好用**（少读文件、句句有据）需要在本机
做的配置。都属**可选增强**：不入仓库、不进依赖树，不做也不影响项目运行。

**codegraph 代码图谱**（推荐）：预索引的代码知识图谱，让 agent 一次调用就拿到相关符号的原文 +
调用路径 + 改动影响面，替代 grep / read 逐文件爬。

```bash
pnpm codegraph:setup   # 装 CLI（已装则跳过）+ 在仓库根建索引；产物 .codegraph/（已 gitignore）
codegraph status       # 查看索引状态与 Added / Modified 待同步项
codegraph sync         # 手动同步（触发条件见下）
codegraph ui           # 浏览器看图：http://127.0.0.1:4747
```

- **接 MCP 才算真正用上**：`codegraph install` 可自动配置 Claude Code / Codex / Cursor 等，但
  **不支持 DeepSeek Harness**。DSH 需手动在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 加一条
  `@deepseek-ai/dsh-mcp-client` 的 `insert`，并**显式指定 `--path` 指向本仓库**（MCP 子进程继承的是
  DSH host 进程的 cwd，未必是本仓库，不给会索引错项目）；接线后模型工具列表出现
  `mcp__codegraph__codegraph_explore`。完整片段见
  [`codegraph` skill 的接入说明](../../.agents/skills/codegraph/references/codegraph-guide.md)。
- **索引同步有前提**：只有 MCP server（`codegraph serve --mcp`，自带文件 watcher）或 daemon 在跑时，
  改代码才会自动进索引；否则索引会**静默过期**（实测能落后一天多），agent 据此读到旧代码——此时
  改完代码手动 `codegraph sync`。
- 未接 MCP 时，agent 经 bash 调 CLI（`query` / `callers` / `impact` 等）同样可用，只是每次多一次
  工具调用。

> 一句话：配了它，agent 改代码时能看见「谁调用、改它影响谁」；不配就退回 grep + 逐文件 read。
