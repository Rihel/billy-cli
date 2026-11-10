# AI 能力

> 产品里的 AI 怎么跑（会话 / 流式 / 工具 / 连接器 / 恢复 / 用量），以及工程怎么让 AI 参与开发。
> 扩展步骤见 [ai-extension-guide](../design/ai-extension-guide.md) 与 `develop-ai-agent` skill。

## 运行时与接口

模板自带一套能上生产的 AI 对话，代码在 `apps/server/src/modules/ai`（运行时 + 工具 + 连接器）+
`ai-model`（供应商 / 模型配置）+ `ai-usage`（用量汇总）。后台有五个页面：
**会话** / 模型 / 工具 / 审计 / 连接器。它和「用 AI 写这个模板」是两件事：
后者靠 Agent Skills（见下节），前者是产品里的 AI。

接口在 `/agent` 前缀下（`AnyAuthGuard`：前台用户与管理员同一套；用量接口仅管理员）：

```text
POST /agent/chat/stream        建立流式对话（SSE）
POST /agent/chat/resume        断线后用 offset 续传
GET  /agent/run/stream         重连当前运行（EventSource 只能 GET）
GET  /agent/run/:runId/stream  重连指定运行
POST /agent/conversation/*     会话增删改查
POST /agent/run/*              运行列表 / 详情 / 停止（审计与复盘）
POST /agent/usage/summary      用量汇总
```

**运行时能力**

- **会话与运行**：`conversations` / `runs` / `timelines` 三张表；运行中进度放 Redis，跑完落 Postgres；
  刷新页面能接着看，服务重启后在跑的会话会恢复（durable 可配）。
- **流式与续传**：文本、推理、工具调用、步骤、来源全细节推送，断线从上次位置继续。
- **工具面**：一个工具一条 `@ToolDecl`（`@ToolGroup` 类 + 方法即工具），注册后统一过网关——
  开关、作用域（主 agent / 子 agent）、限额、自定义事件、审计、大结果分页与 `read-tool-result` 回取。
  内建 10 个：计划四件套、`run-sub-agent`、`run-command`、`read-tool-result`、`web-search`、`web-fetch`、`web-request`。
- **连接器**（`modules/ai/connectors`）：外部能力不再写死进代码。后台「AI → 连接器」加一条实例
  （地址 + 凭证），就产出一组受管工具，走的是和内建工具同一个网关（开关、限额、审计、脱敏一致）。
  内置 4 个型号：**PostgreSQL / MySQL**（查表结构与只读查询）、**Redis**（按前缀只读扫键 / 读字符串与哈希）、
  **飞书 CLI**（受限 `run` + CLI 内嵌技能文档，覆盖消息 / 文档 / 多维表格 / 日历等 20+ 业务域）。
  目录（有哪些型号）、实例（连的谁）、远端能力、工具四层分开；换地址 / 换密钥 / 停用整家服务只改数据，不发版。
- **运行控制**：动态子 agent（提示词由主 agent 现场写）、命令执行（开关 / 工作目录 / 时长与输出上限可配）、
  联网预算（统一 UA、超时、字节上限、内网拦截）。
- **多模态附件**：图片与 PDF 走对象存储，只传 key；附件 key 做归属校验，不能越权读他人文件。
- **上下文**：达到模型窗口 70% 触发裁剪 / 压缩，原文保留可回看。
- **模型与用量**：供应商表 + 模型表在后台配（不用改环境变量），运行时只用配过的模型；
  每轮 tokens 与步数入库，按日 rollup，按模型 / 按 agent 汇总；`ai/audit` 页面可回放调用。
- **前端**：`@repo/ui` 内置 48 个 ai-elements，后台会话页开箱可用。

**配置位置**：模型与供应商在「AI → 模型管理」，工具开关与限额在「AI → 工具配置」，
外部服务在「AI → 连接器」，用量在「AI → 审计」与控制台。
设计细节与取舍见 [`docs/design/ai-agent.md`](../design/ai-agent.md)、
[`docs/design/ai-agent-tool-engine.md`](../design/ai-agent-tool-engine.md) 与
[`docs/design/ai-connector.md`](../design/ai-connector.md)。

## Agent Skills（AI 原生开发）

工程把「怎么做」写进 skill：`.agents/skills/` 下每个 skill 是一个独立目录（标准 Agent Skills 格式，
`SKILL.md` 带 YAML frontmatter 的 `name` + `description`，大块内容拆到 `references/`），
AI 编码 Agent 按任务**按需加载**，工具无关（Claude Code / Codex / Cursor 等均可读取）。

- **最高准则**：[AGENTS.md](../../AGENTS.md)（8 条首要准则，先于一切 skill 与规范）；Claude Code 入口为
  [CLAUDE.md](../../CLAUDE.md)
- **必读入口**：`billy-dev-foundation`（分层架构、代码约定含「不重复造轮子」实现查找顺序、常用命令、标准流程）
- **共 27 个 skill**：必读 1（`billy-dev-foundation`）+ 功能 25（`define-data-structure` / `define-dict-enum` /
  `database` / `develop-business-module` / `develop-backend-api` / `develop-frontend-page` / `develop-ai-agent` /
  `ai-agent-engineering` / `implement-auth` / `object-storage` / `concurrency` / `kafka` / `scheduler` / `stream` /
  `telemetry` / `notification` / `lark` / `state-machine` / `write-tests` / `git-workflow` / `codegraph` /
  `getting-started` / `table-state` / `migrate-v8-to-v9` / `tsdown`）+
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
