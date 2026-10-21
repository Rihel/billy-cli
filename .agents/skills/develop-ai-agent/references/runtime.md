# AI 运行时：会话 / 运行 / 时间线 / 流式 / 恢复

> 本文件是 `develop-ai-agent` skill 的组成部分。权威设计见 `docs/design/ai-agent.md` §3–§5。

## 1. 三张表与三种状态

| 表 | 一行是什么 | 关键列 | 可删？ |
| --- | --- | --- | --- |
| `conversations` | 一个对话窗口 | `user_id` / `agent_key` / `turn_count` / `total_tokens` / `last_active_at` | **只能软删**（`deleted_at`） |
| `runs` | 一次执行（根 = 一轮问答；子 = 子 agent） | `parent_run_id` / `depth` / `tool_call_id` / `status` / `usage` / `error_*` / `heartbeat_at` | **永不删** |
| `timelines` | 会话里发生的一件事（一行一个 part） | `seq`（排序权威）/ `run_id` / `message_id` / `kind` / `tool_call_id` / `payload`（全量） | **永不删** |

- **根 run 与子 run 同表**：`parent_run_id IS NULL` 才是"一轮"；
- 并发保护靠部分唯一索引 `uk_run_active_conversation (conversation_id) WHERE parent_run_id IS NULL AND status IN ('pending','running')`
  → 同一会话同时只允许一次进行中的**根**运行（子 run 与父 run 同时跑是正常状态）；
- 幂等键 `uk_run_tool_call (parent_run_id, tool_call_id)`。

**进度放 Redis、结果放 Postgres**：运行中的 step / 当前动作 / offset / 心跳在 Redis（`agent:run:{runId}`，TTL 6h），
跑完删；终态、消耗、统计落 `runs`（长期保留）。看门狗按 `heartbeat_at` 与总时长判超时
（`markTimeout` 的判据必须与 `findStale` **完全一致**，否则会出现"心跳还在跳但超时"处置不掉的 bug）。
看门狗必须同时扫 **`pending`**（`startRun` 先插 pending 再置 running，中间失败会卡死会话），
判据用 `COALESCE(heartbeat_at, created_at)` / `COALESCE(started_at, created_at)` ——
pending 行两个时间列为 NULL，直接比较会永远为 false。

**进程重启的清理（单副本）**：`AgentRecoveryService` 启动时先 `recoverOnBoot()`，再把
`updated_at < 启动时刻` 的 `pending/running` 标成 `interrupted`（`RunRepository.interruptActiveBefore`）。
不这样做的话，`node --watch` 每次重启都会让上一轮"没人管却仍是 running"，用户下一次发送只能
拿到 3306，直到看门狗 60s 后判超时。多副本不做（别的副本可能还在跑）；测试环境跳过
（`app-bootstrap` 会把应用跑在开发库上，不能误伤开发者正在跑的一轮）。

## 2. 上下文策略（按模型窗口比例，不拍脑袋）

`AgentConfig` 的比例（比例都相对**模型窗口**，窗口来自 `tokenlens`，查不到用兜底值）：
**触发 0.7**（`contextTriggerRatio`，`runtime/context.service.ts:153`）→ **裁剪到 0.5**
（`contextTrimTargetRatio`，`:155`）；**最近 3 轮永不裁**；单条工具结果给模型的视图上限 0.1
（`contextToolResultMaxRatio`，`:162`；**落库仍是完整原文**）。

> ⚠️ **`contextCompactTargetRatio`（默认 0.4）是未被读取的旋钮**（2026-10-01 核实）：它在
> `app-config.ts:123,333` 可配、`core/config.ts:18` 有类型，但 `runtime/context.service.ts` 里
> **没有任何消费方** —— 压缩（`trim+compact`）以 `kind='summary'` 的摘要事件顶替被压缩区间，
> 之后**没有"压到某个比例"的目标线**，真实兜底是"连最近 1 轮都装不下就抛 `ContextTooLongError`"
>（`:278`）。要么接线，要么删掉这个旋钮，别让它继续误导（本行此前写"压缩到 0.4"即为误述，已更正）。

**组装上下文只看根 run 的事件**（`listSince(..., { rootOnly: true })`）：子 agent 的内部过程是审计资料，
回灌给主模型既费窗口又污染上下文。压缩产物是 `kind='summary'` 的事件（原文保留，摘要只是"给模型的新起点"）。

## 2.1 对话附件（多模态输入）

**只传存储 key，不传文件内容**：请求体上限就是 2mb（`main.ts` 的 `useBodyParser`），
把 2MB 的图内联进去必然 413。链路是「前端预签名直传对象存储 → 随消息只交 key →
服务端按 key 取回」（`AgentChatSchema.attachments`）。

| 类型 | 喂法 |
| --- | --- |
| 图片（png/jpeg/webp/gif） | `image` part，内容用 data URL（不依赖供应商能否访问内网存储） |
| 文本类（txt/md/csv 及常见代码后缀） | 内联成 `text` part，≤2 万字符、截断明示 |
| 其它二进制 | `file` part（data URL），交给上游解析 |

三件改它之前必须知道的事：

1. **附件的 token 成本要参与裁剪判断**：`buildContext` 先取回内容、算出成本，经
   `BuildContextInput.extraInputTokens` 传给 `ContextService`（估算与 0.7 阈值都算上）。
   早先把它放在 `buildInput` 之后注入，结果是裁剪决策看不见它 —— 一张图按 data URL 长度
   折算能得出几十万 token 的假结论。规则本身在 `@repo/shared` 的 `estimateContentTokens`。
2. **`withUserContent` 不静默失败**：末条不是 user 消息时抛错（否则附件被悄悄丢掉）。
3. **历史轮次的图片不回灌**（`toSegments` 只读 `payload.text`）：这是**明确取舍**，
   不是 bug；多轮图片对话从第二轮起模型看不到上一轮的图。要做就得同时解决"每次组装都取对象"
   与"把 data URL 塞进历史"两件事。

**模型不一定收图**：能力是**模型实体的独立字段**，不在 `capabilities` jsonb 里（那一列是
"供应商给什么存什么"，同步会整列覆盖）：

| 字段 | 说明 |
| --- | --- |
| `mode` | 模型类型（`AiModelMode`，对齐 LiteLLM 的 `mode`）；agent 的可选模型只列对话类，`unknown` 照列 |
| `input_modalities` | 输入模态数组（`AiModality`，对齐 OpenRouter 的 `architecture.input_modalities`） |
| `output_modalities` | 输出模态数组 |

**三态**：`null` = 未声明（**不拦**附件，只提醒）/ `[]` = 明确什么都不支持（拦）/
`["text"]` = 明确只收文本（拦图片与文件）。判据是 `@repo/shared` 的 `attachmentCapabilityIssue`
（输入是模态数组），前后端共用；服务端权威校验在 `ChatAttachmentService.assertSupported`，
明确不支持抛 **3312**，未声明只留 warn。

**解析在适配器里**（`provider-adapters.ts` 的 `parseModalities` / `parseMode`）：认 OpenRouter 的
`architecture.*`、LiteLLM 的 `supports_vision` / `supports_pdf_input` 布尔位、顶层
`input_modalities` / `modalities`、以及 `capabilities` 里的词（认 `vision`→`image`、`pdf`→`file` 同义词）。
**都认不出落 `null`，绝不编造** —— 包括不把输出默认成 `["text"]`（清单里混着 embedding / 图像生成模型）。
同步时 `input.inputModalities ?? existing.inputModalities`：供应商没给就**保留人工填的**，
别改回"整列覆盖"（`ai-model-module.test.ts` 的 ⑤c 钉住）。

**一份附件在三个地方各存什么**：对象存储存**文件本体**（前端预签名直传）、请求体只传
`{key, filename, mediaType, bytes}`、`timelines.payload` 落**同样的元数据**（绝不落 base64 ——
审计表"一律不裁剪"，塞几 MB 图片会撑变形）。模型输入那一步再按 key 取回转成 data URL。

⚠️ **key 是客户端给的，读对象前必须校验归属**（`AttachmentKeyPolicy.assertOwned`）：
前台用户必须落在 `user/<自己的 id>/` 前缀内，否则就是一条越权读取（伪造
`user/<别人的 id>/x.png` 就能把别人的文件读出来喂给模型）。越权抛 3202，**不静默跳过那条附件**。
管理员与鉴权关闭按现状放行（与 `StorageController` 同一姿态）。改附件链路时这一步不能省。

⚠️ **多模态 + `durable: true` 曾整段丢图（2026-10-07 事故，已随升级修复）**：
`@mastra/core@1.69.0` 在 durable（可恢复执行，线上默认开）下会把 `content` 数组**压平成纯字符串**，
出站请求只有 **156 字节**、`content: "看图"` —— 症状是"模型说没收到图片"，看着像模型不支持读图。
**升到 `1.75.0` 后正常**（上游已修）。排查这类问题的正确姿势：**让真实路径跑一次并抓出站请求**，
不要逐环节证明"某环节没问题"；同时**实验必须与生产同配置**（早期实验全用 `new Agent()` 默认非 durable，
所以完全看不见它）。回归防线在 `ai-mastra-contract.test.ts` 的"durable 下的多模态"，
**那条必须走 `durable: true`**。另外：调用时显式传模型实例是稳妥做法（别依赖 Agent 上的动态 model
去让 Mastra 自解析配置，那一层曾丢过多模态）。

**降级顺序**（`readAttachment`）：图片 → image；**PDF → 先本地抽文字层（`extractPdfText` / unpdf）
内联成文本**，抽不到（扫描件 / 加密）才退回 file —— 退回时**才**判模型的"文件输入"能力；
这一步必须排在"当文本试"**之前**（否则 PDF 里那段可读 ASCII 会被当文本内联）；认不出类型的 → 先当文本试；都不行才拒绝。

⚠️ **别只依赖供应商的文件通道**：**DeepSeek 的文件通道只支持图片格式**（实测发 PDF 直接 `400`：
`one of the following formats: webp, png, jpeg, and gif`），而 `@ai-sdk/deepseek` 对非图片 file part
只记一条警告后**静默丢掉**（运行照样"成功"，模型回答"我没收到文件"）。
所以 PDF 一律先本地抽文字 —— 那条路对任何模型都有效，也不受各供应商能力差异影响。
能力判据 `attachmentCapabilityIssue` 因此**只判图片**：PDF / 文本类不需要模型有对应能力。

测试：`test/ai-chat-attachment.test.ts`（三类喂法 / 截断 / 取不回抛错 / 能力校验 / 文本降级 / `withUserContent`）；
**测试里手工 `new AgentChatService(...)` 是位置参数**，加依赖时必须同步补位（`test/helpers/attachments.ts`
给了替身），漏补的症状是"logger 不是函数"这类与真实原因毫不相干的报错。

## 3. SSE 流式协议（AI SDK v6 UI Message Stream）

- 端点：`POST /agent/chat/stream`（建流，**不套业务信封**）、`GET /agent/run/:runId/stream?offset=N`
  （知道 runId 时续流）、`GET /agent/run/stream?offset=N`（**不知道 runId 时续流**：服务端按登录用户找
  当前进行中的那一轮，没有回 204）、`POST /agent/run/stop`（停止）；两条续流都必须是 GET —— AI SDK 的
  `reconnectToStream` 固定发 GET，指到 POST-only 的建流地址会 **404**（踩过）；
- 帧格式 `data: {json}\n\n`，结束 `data: [DONE]\n\n`；响应头有 `x-vercel-ai-ui-message-stream: v1`、
  `x-accel-buffering: no`；心跳是 SSE 注释帧 `: ping\n\n`（自写，15s）；
- ⚠️ **心跳写入必须先续租、且只在 `writeHead` 之后写**：客户端断开 / 响应已结束时
  `response.write()` 会抛「Connection is closed.」，而它跑在定时器里 = 进程级未捕获异常 =
  `process.exit(1)`（表现为"聊着聊着服务重启、其它会话全丢"）。响应头之前写还会隐式发出 200，
  随后 `writeHead(200, SSE_HEADERS)` 抛 `ERR_HTTP_HEADERS_SENT`。统一走 `writeSse` / `endSse`。
- **`startRun` 之后的所有步骤都要在 try 里**：模型解析 / 读附件 / 组装上下文失败时，
  早先只留下一条 `running` 行（没有错误、后续 3306）；现在失败落终态，且响应头未发时把真实
  错误码抛回 HTTP（3406 / 3311 才能传到前端 `onError`）。
- **`[DONE]` 在收尾落库之后才发** —— 客户端见到它就代表终态已写库；
- 每个片段同时落三处：时间线（真相）/ Redis 输出记录（补发）/ pub/sub（跨副本）；
- ⚠️ **补发不能直接从 offset 切**：offset 可能落在 reasoning / text / tool-input 中间，
  AI SDK 的状态机收到没有 `*-start` 的 delta 会整页报错。`resumeRun` 先读全量，
  由 `runtime/stream-resume.ts` 回退到当前块开头并补回消息 `start`；找不到开头时补 start，
  孤立 end 丢弃。改续流逻辑时别绕过它；
- **`data-*` 块**（前端渲染的细节都在这）：`data-run`（本轮身份，**第一个块**，不带 id）/
  `data-sub-agent`（子助手状态快照，**带 id = 子 run id，同 id 覆盖**）/
  `data-sub-agent-delta`（子助手增量，**不带 id，一块一个**）。
  ⚠️ AI SDK 的 data part 按 id 归并 —— 增量绝不能用固定 id，否则只会剩最后一块。

## 4. 停止与重连（两处官方语义坑）

1. **`useChat().stop()` 只断本地连接，不取消服务端生成** → 停止必须再调 `POST /agent/run/stop`
   （服务端本进程直接 abort；不在本进程则经 Redis 停止频道广播给持有者）；
2. **重连靠 `useChat({ resume: true })`**，不要在 `useEffect` 里手调 `resumeStream()`（StrictMode 下会重复）；
   前端用 `prepareReconnectToStreamRequest` 把 runId 换成我们的续流地址。

## 5. 崩溃恢复（三档，代价要说清）

**durable 是什么**（一句话）：这一轮问答跑到一半、服务崩了/重启了，回来能**接着跑**。
做法是**每走完一步就把状态存一份**到 `runs.snapshot`；启动时抢 Redis 租约 →
`mastra.recoverAllDurableAgents()` 接上。代价：恢复是**从上一个快照重放**，
会重发模型调用、重跑工具，**真花钱** —— 所以工具必须幂等、恢复次数有上限、要有看门狗兜底。

⚠️ **两条改它之前必须知道的**：
1. **快照能落库的前提是 `runs.engine_run_id` 有值**：落库语句是
   `UPDATE runs SET snapshot ... WHERE engine_run_id = :runId`，对不上就静默丢快照
   （只记 `ai.storage.snapshot_orphan_skipped`）。**2026-10-07 之前这里是空的**，
   于是"崩溃续跑"从未真正生效（60 条运行只有 13 条早期手工造的带快照）。
   现在由我们生成 `eng_<runId>` 并起跑时回写、同时交给 `agent.stream(..., { runId })`。
   **别改成"让 Mastra 自己生成"** —— 那样 id 又对不上了。
2. **`durable: true` 会让 Mastra 走另一条代码路径**，多模态内容在那里曾被压平
   （§附件那节的记录）。排查"图片没到模型"这类问题，**务必用与生产相同的 durable 配置复现**；
   早期实验全用 `new Agent()`（默认非 durable），所以完全看不见那个 bug。

## 6. 收尾里还做了一件"隔离"的事：首轮自动命名

第一轮问答收尾时（`recorder.finish` 之后、`runs.finish` 之前），把**这一轮的记录**交给模型起一个
≤10 字的会话名（`runtime/title.service.ts`，指令模板 `prompts/templates/title.eta`）：

- **与 agent 上下文完全隔离**：现场造临时 agent（只有命名指令，**没有工具 / 技能 / 记忆 / 信封**），
  不复用 `mastra.getAgent()`；mock 侧就是靠"唯一不带 tools 的请求"认出它；
- **只在首轮**（开局 `turnCount === 0`）+ **只在标题还是兜底那版**（用户改过名就不动）；
- 失败 / 超时（10s）/ 收拾不出名字 → 保留"首条消息"那版（起名不能拖垮一轮问答）；
- 这次调用的 usage **并进该轮 run**：`{ ...usageBase, ...(mergeUsage(usageBase, title.usage) ?? {}) }`
  —— 注意**先展开 usageBase**，否则 `usage.subAgents` 这类非 token 字段会被 `mergeUsage` 抹掉（踩过）；
- **新标题要推给前端**：收尾时下发 `data-conversation-title`（与 `data-run-usage` 同一手法进 Redis，
  断线补发也拿得到），前端 `onData` 就地改会话列表与详情缓存；另外一轮结束时前端还要失效
  `['ai','conversations']` / `['ai','conversation',id]` —— 轮数、token 累计、排序只在库里变，
  不重取就一直显示旧值（用户反馈"重命名没有前端实时响应"就是这么来的）。
