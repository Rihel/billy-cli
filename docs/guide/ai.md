# AI 能力

> 产品里的 AI 怎么跑（会话 / 流式 / 工具 / 连接器 / 恢复 / 用量），以及工程怎么让 AI 参与开发。
> 扩展步骤见 [ai-extension-guide](../design/ai-extension-guide.md) 与 `develop-ai-agent` skill。

## 运行时与接口

模板自带一套能上生产的 AI 对话，代码在 `apps/server/src/modules/ai`（运行时 + 工具 + 连接器）+
`ai-model`（供应商 / 模型配置）+ `ai-usage`（用量汇总）。后台有八个页面：
**会话** / 模型 / 工具 / 技能库 / 记忆 / 文件管理 / 连接器 / 审计。它和「用 AI 写这个模板」是两件事：
后者靠 Agent Skills（见下节），前者是产品里的 AI。

接口在 `/agent` 前缀下（`AnyAuthGuard`：前台用户与管理员同一套；用量接口仅管理员）：

```text
POST /agent/chat/stream        建立流式对话（SSE）
POST /agent/chat/resume        断线后用 offset 续传
GET  /agent/run/stream         重连当前运行（EventSource 只能 GET）
GET  /agent/run/:runId/stream  重连指定运行
POST /agent/conversation/*     会话增删改查（含 file-access 切换文件权限）
POST /agent/run/*              运行列表 / 详情 / 停止（审计与复盘）
POST /agent/file/*             会话工作区文件列表 / 预览 / 后台跨会话列表与统计
GET  /agent/file/workspace-content  按 cookie 读工作区文件（Range / 下载）
POST /agent/usage/summary      用量汇总
```

**运行时能力**

- **会话与运行**：`conversations` / `runs` / `timelines` 三张表；运行中进度放 Redis，跑完落 Postgres；
  刷新页面能接着看，服务重启后在跑的会话会恢复（durable 可配）。
- **流式与续传**：文本、推理、工具调用、步骤、来源全细节推送，断线从上次位置继续。
- **工具面**：一个工具一条 `@ToolDecl`（`@ToolGroup` 类 + 方法即工具），注册后统一过网关——
  开关、作用域（主 agent / 子 agent）、限额、自定义事件、审计、大结果分页与 `read-tool-result` 回取。
  内建 29 个：计划四件套、`run-sub-agent`、`bash`、`read-tool-result`、`web-search` / `web-fetch` / `web-request`、
  长期记忆三件套（`memory-save` / `memory-search` / `memory-forget`）、
  技能库七件套（`skill-list` / `skill-save` / `skill-file-save` / `skill-file-append` / `skill-delete` /
  `skill-enable` / `skill-import`），以及文件管理九件套（`file-submit` / `file-download` / `file-list` /
  `read-file` / `file-search` / `workspace-files` / `write-file` / `replace-file` / `append-file`）。
  另有 3 个 Mastra 运行时自带、不进注册机的工具（`skill` / `skill_search` / `skill_read`），后台工具清单只读展示。
  agent 的授权清单支持选择器（`'*'`、`{ category }`、`{ connector }`），装配期按调用身份过滤作用域——
  没授权的工具**根本不会出现在模型面前**。
- **技能库**（`modules/ai/skills`）：后台「AI → 技能库」在线写技能（类 Notion 的块编辑器写正文 +
  `references/` / `scripts/`），也能贴 skills.sh / GitHub 链接把技能**下载进库**；启停立即生效、不用重启。
  DB 是事实源，服务端落盘到 `~/.billy/skills`（`AGENT_SKILLS_LIBRARY_DIR`）供 Mastra 按需读；
  agent 也能用 `skill-save` 等工具自己建技能，写入入口只有管理员（技能内容会进入模型上下文）。
  模型侧提示词要求**先扫技能清单**：有匹配的就先 `skill` 加载再动手；设计 / 页面 / 报告类任务先加载设计类技能再写第一版，不要等用户点名。
- **长期记忆**（`modules/ai/memory`）：`ai_memories` 按用户存画像 / 偏好 / 事实 / 约束；
  agent 用 `memory-save` / `memory-search` / `memory-forget` 读写（身份取运行时信封，子 agent 不可用），
  后台「AI → 记忆」可查看 / 编辑 / 停用 / 删除。每轮按置顶 + 最近使用注入 system 消息
  （≤20 条、≤800 token），注入了哪些 id 写进 `request_snapshot`；短期 thread 落 Redis，重启 / 多副本不丢。
- **文件管理**（`modules/ai/files`）：`ai_files` 记会话文件（入站附件引用 + AI 提交，按会话级 workspace 组织），
  九个文件工具全部过同一套网关；对话右栏按会话看文件，后台「AI → 文件管理」跨会话列表 / 预览 / 分享
  （总量统计在控制台）；Office 前端直连对象存储，S3 / COS 需配 CORS。管理员还能给文件生成**免授权分享链接**
  （`/s/{token}`，有效期可选、明文 token 只显示一次、可撤销，OSS 地址不进浏览器）。
- **连接器**（`modules/ai/connectors`）：外部能力不再写死进代码。后台「AI → 连接器」加一条实例
  （地址 + 凭证），就产出一组受管工具，走的是和内建工具同一个网关（开关、限额、审计、脱敏一致）。
  内置 4 个型号：**PostgreSQL / MySQL**（查表结构与只读查询）、**Redis**（按前缀只读扫键 / 读字符串与哈希）、
  **飞书 CLI**（受限 `run` + CLI 内嵌技能文档，覆盖消息 / 文档 / 多维表格 / 日历等 20+ 业务域；
  授权状态存 `ai_connectors.auth_state`，无状态 pod 重启 / 换实例后不用重新授权）。
  目录（有哪些型号）、实例（连的谁）、远端能力、工具四层分开；换地址 / 换密钥 / 停用整家服务只改数据，不发版。
- **运行控制**：动态子 agent（提示词由主 agent 现场写）、命令执行（开关 / 工作目录 / 时长与输出上限可配，
  `AGENT_COMMAND_ENABLED` 默认关闭）、联网预算（统一 UA、超时、字节上限、内网拦截）。
- **工作区运行时**：`bash` 与文件工具共用会话工作区；模式 `read-only` / `workspace-write` / `danger-full-access`，
  部署默认 `enforce`——会话只能选沙箱内的只读 / 可写，沙箱不可用就**拒绝执行（fail closed）**，
  只有自托管单租户显式设 `AGENT_WORKSPACE_MODE=off` 才降级为宿主进程执行；沙箱网络默认 `deny`；
  `GET /info` 暴露部署模式与会话可选的文件权限。
- **多模态附件**：图片与 PDF 走对象存储，只传 key；附件 key 做归属校验，不能越权读他人文件。
- **上下文**：达到模型窗口 70% 触发裁剪 / 压缩，原文保留可回看。
- **模型与用量**：供应商表 + 模型表在后台配（不用改环境变量），运行时只用配过的模型；
  每轮 tokens 与步数入库，按日 rollup，按模型 / 按 agent 汇总；`ai/audit` 页面可回放调用。
- **前端**：`@repo/ui` 内置 48 个 ai-elements，后台会话页开箱可用。

**配置位置**：模型与供应商在「AI → 模型管理」，工具开关与限额在「AI → 工具配置」，
技能在「AI → 技能库」，长期记忆在「AI → 记忆」，文件在「AI → 文件管理」，外部服务在「AI → 连接器」，
用量与调用回放在「AI → 审计」与控制台。
设计细节与取舍见 [`docs/design/ai-agent.md`](../design/ai-agent.md) 与
[`docs/design/ai-agent-tool-engine.md`](../design/ai-agent-tool-engine.md)；
连接器的现状与方向见 skill
[`develop-ai-agent/references/connector.md`](../../.agents/skills/develop-ai-agent/references/connector.md)。

## 定义自己的 agent

内置的 `assistant` 是**能力上限的示例**（工具面 `'*'`，给所有工具）；产品里的 agent 应该按职责裁剪。
新增一个 agent = `agents/<名字>.agent.ts` 写一份 `AgentSpec` + `agents/index.ts` 登记一行 + 一个提示词模板，
不用改 core 的任何装配代码。

```ts
// apps/server/src/modules/ai/agents/researcher.agent.ts
import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import type { AgentSpec } from './types.js'

export const researcherAgent: AgentSpec = {
  key: 'researcher',
  name: '资料助手',
  description: '查资料、读网页、整理结论；不执行命令',
  tools: [
    TOOL_KEYS.webFetch,          // 具体 key
    TOOL_KEYS.webSearch,
    TOOL_KEYS.readToolResult,
    { category: 'connector' },   // 连接器产出的工具（受作用域再过滤一层）
  ],
  skills: [],                    // 只挂它要用的技能；没有就不挂，别写 ALL_SKILLS
  prompt: { template: 'researcher' },
}
```

```ts
// agents/index.ts
export const AGENT_SPECS: readonly AgentSpec[] = [assistantAgent, researcherAgent]
```

四条口径：

1. **工具写什么**：具体 key（从 `TOOL_KEYS` 取，写错启动期报错）、`'*'`（只给示例 agent）、
   `{ category: 'business' | 'connector' | ... }`、`{ connector: '<实例 key>' }`（可再带 `tool` 精确到一个工具）。
   连接器选择器允许零命中——连接器是运行期同步进来的，启动时可能还没同步。
2. **不给的就是不给**：不在清单里的工具不会出现在模型面前；不要用提示词写「不要用某工具」，
   那约束不住模型，授权能。子 agent 的工具面 = **父 agent 的授权面 ∩（全部 − 委派类 − `child: 'deny'`）**。
3. **作用域是第二层**：连接器工具默认 `scope: 'admin'`；要给产品 agent 用，就在「AI → 工具配置」里
   把作用域改成 `agent` 并填 `allowedAgents`（或 `all`）。装配期会按调用身份再过滤一遍，
   前台用户根本看不到管理员工具。
4. **提示词里的工具清单是渲染出来的**：模板里不要手写工具名，`registry.describe()` 会按实际授权清单生成。

验证：启动不报错 → `POST /agent/list` 看这个 agent 的工具数 → 跑一轮后查审计 `request_snapshot.toolKeys`
（应当是**展开后的具体 key**，不是选择器）→ 分别用管理员和前台用户身份各跑一次，确认作用域。

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
  定过的取舍。入口是索引表（30 条以内，每条一句话），命中主题再读卡片；卡片带「依据」「失效信号」与
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
