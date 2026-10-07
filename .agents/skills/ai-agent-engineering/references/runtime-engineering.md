# 运行时工程：token 账 / 上下文 / 限额 / 取消 / 恢复 / 可观测（ai-agent-engineering 引用文件）

> 本文件是 `ai-agent-engineering` skill 的组成部分，由主 SKILL.md 引用。

前置：**机制**（会话运行链、上下文策略的实现入口、SSE 协议与恢复三档）见 `develop-ai-agent`
及其 `references/runtime.md`。本文件只讲**工程判断**：账在哪、阈值多少、判错的后果、当前缺口。

## 1. 一轮对话的账

| 进模型输入的项 | 来源 | 计量方式 |
| --- | --- | --- |
| 系统提示词 | `definition.instructions`（`chat.service.ts:405`） | 估算（`estimateTokens`） |
| 历史消息 | 时间线重建（`context.service.ts:289` `toSegments`） | 估算 |
| 工具出参 | 全量落库，给模型的是投影（见 §3） | 估算 |
| 摘要 | `kind='summary'` 事件正文（`context.service.ts:180-187`） | 估算 |
| **工具清单**（名字/说明/参数 schema） | 注册机 → 适配器 → Mastra | **不进裁剪预算**（`messagesTokens` 只遍历 `messages`，`context.service.ts:428-438`） |
| 推理过程 | — | **不进模型输入**，只审计（`context.service.ts:422`） |
| 真实用量 | provider 上报 | `runs.usage`（jsonb，`run-entity.ts:110-112`）；步级明细在 `timelines` 的 step 行 |

- **估算口径**（`context.service.ts:85-93`）：CJK 1 字 = 1 token，其余 4 字符 ≈ 1 token；本地没有
  tokenizer，**裁剪预算一律用估算**（宁可多裁），真实数只认 provider 的 `usage.inputTokens`（`:82-84`）。
- **落库字段**（`usage.ts:21-44`）：`inputTokens` / `outputTokens` / `totalTokens` / `cacheReadTokens` /
  `cacheWriteTokens` / `reasoningTokens`；provider 没上报就落 **`null`，不编造 0**（`:11-13`，前端显示"—"）。
  缓存读**要读两处**：顶层 `cachedInputTokens` 优先、嵌套 `inputTokenDetails.cacheReadTokens` 兜底（`:14-19, 33-36`）。
- **合账**：`rollUpUsage`（`chat.service.ts:1197-1205`）把子 run 用量相加成 `usage.subAgents`；父子是两次
  独立计费，**相加不取最大**（`usage.ts:54-59`）。`mergeUsage` 只逐字段加 token，**不能直接当 usage 用**
  ——会抹掉 `subAgents`（踩过，`chat.service.ts:267-271, 830-834`）。
- **失败也记账**：失败收尾写 `usage: await this.rollUpUsage(run.id, null)`（`chat.service.ts:931-940`），
  子 agent 已烧的 token 不丢。
- **自动命名也在这笔账里**：`title.service.ts:108` 的 usage 并进该轮（`chat.service.ts:269-271, 832-834`）；
  上限 `10` 字（`title.service.ts:12`）、`10s` 墙钟（`:15`）、`32` 输出 token（`:18`）、transcript `2000` 字符（`:21`）。
- **下发**：`data-run-usage`（`chat.service.ts:894-906`，不带 id）在**终态落库之后、`[DONE]` 之前**发出，
  于是"客户端看到用量"就代表"库里已经有了"；同时进 Redis 记录 + 广播，断线补发也拿得到（`:886-892`）。
  前端消费在 `data.ts:85-92` → `chat-conversation.tsx:482`（`onData` 里**没有**这个分支，别去那里找）。
- **为什么用量必须能解释**：账上的每个数要么指到 provider 的上报，要么是 `null`；出现"界面有数、库里没有"
  或"库里 0、实际上报缺失"就是 bug（后者用 `null` 语义根治）。

## 2. 上下文组装与压缩

四种策略在 `ContextService.buildInput` 内同一条链上判；阈值是 `AgentConfig` 的比例（默认值
`apps/server/src/app-config.ts:119-129`：触发 `0.7` / 裁到 `0.5` / 最近 `3` 轮不裁 / 单条工具视图 `0.1` / 兜底窗口 `32000`）：

| 触发条件 | `strategy` | 产出 | 位置 |
| --- | --- | --- | --- |
| 估算 ≤ 窗口 × 0.7 | `window` | 原样用 | `context.service.ts:239-241` |
| 超触发线 → 从最旧丢到 ≤ 窗口 × 0.5 | `trim` | 记 `droppedSeqs` | `:243-255` |
| 裁剪后仍 > 触发线且有可压区间 | `trim+compact` | 带 `needsCompaction` + `compactionRange` | `:257-273` |
| 连"最近 N 轮"都装不下 | `fallback` | 只留 system + 最近 1 轮 | `:275-285` |
| 兜底仍 > 模型窗口 | **抛 `ContextTooLongError`（3307）** | 不硬塞（硬塞被上游 400） | `:278-281` |

- **永不裁**：系统提示词、最近 `contextKeepRecentTurns` 轮（`protectedFromTurn`，`:192-196`）、当前用户输入、
  **工具调用与结果的配对**（配对不可拆，`:95-102, 406-411`）。
- **单次读事件上限 `MAX_EVENTS = 2000`**（`:16-17`）：防超长会话把内存撑爆；超出的本来就该被压缩。
  组装**只看根 run 事件**（`rootOnly: true`，`:168-174`）——子 agent 的内部过程回灌既费窗口又污染上下文。
- **压缩在编排层执行，不在 `ContextService`**：`needsCompaction` + `compactionRange` 回到
  `chat.service.ts:205-221`（流式 `:656-668`）→ `summarize()`（`:437-499`）：把区间内的 text / tool-call /
  tool-result 拼成文本，用**当前 agent** 跑一次 `maxSteps: 1` 的调用（`:466-475`），落
  `kind='summary'` 事件（payload 含 `coversSeqs` / `model` / `sourceEventCount`，usage 也落），正文截 `2000` 字符
  （`:80, 476`）→ **重新组装一次**（`:220` / `:667`）。
- **摘要顶替了什么**：`buildInput` 读 `latestSummary`（`:167`），只从 `summary.seq` 之后读事件（`:169-174`），
  并把摘要作为第二条 system 消息注入（`:180-187`）。原文仍在时间线里，但**模型的起点换了**。
- **压缩的代价（不可逆的信息损失 + 一次额外模型调用）**：旧轮次的细节不再逐条进模型；压缩失败**降级为纯裁剪**
  并落一条 status 事件（`chat.service.ts:500-509`），复盘能看出"这里本该有摘要"。
- **本轮的纪律**：重要结论要进出参 / 计划 / 摘要，别只留在对话正文里 —— 对话正文是第一个被裁掉的东西。
- **诚实标注的边界**：一次组装**只压一次**（`:203` 注释）；压缩后若仍超线，第二次组装会落到 `trim`/`fallback`
  或抛 3307，**没有"多轮迭代压缩"**。另外 `contextCompactTargetRatio`（默认 `0.4`，`app-config.ts:123`）
  在 `AgentConfig` 里有声明、在 env 里可配，但 **`ContextService` 从未读它（死旋钮）**：
  压缩后的硬上限实际是**模型窗口本身**（`context.service.ts:278`），不是 0.4 ——
  别照着"压缩到 0.4"去推行为（该说法见 `develop-ai-agent/references/runtime.md:24`，与代码不符）。
- **快照是审计证据**：`runs.request_snapshot.context`（`chat.service.ts:280-287, 844-851`）记下 `strategy` /
  `includedSeqs` / `droppedSeqs` / `summarySeq` / `toolResultTrim` / `keepRecentTurns`（`context.service.ts:33-49`）
  —— 对模型可以省，对审计必须诚实（`:112`）。

## 3. 工具出参进上下文的投影

一句话：**返回值全量、时间线全量、日志全量；只有"给模型的那一份"变小**。

| 位置 | 做什么 | 关键行 |
| --- | --- | --- |
| `paginate.plugin`（post） | 出参超限才分页；全量进 `ToolResultStore`，把出参包成 `{__toolPaged, page, data: 全量}` | `paginate.plugin.ts:25-54` |
| 句柄 | `tr:<会话 id>:<工具调用 id>`（不加密，取页时校验归属） | `paginate.ts:17-30` |
| `toModelOutput`（适配器） | 只把"给模型的那一份"换成第一页（页头 + 本页 + 取下一页提示） | `tool.adapter.ts:80-83`；`paginate.ts:89-97` |
| 跨轮重分页 | 库里是 `__toolPaged` 时，用**同一个纯函数**重算第 1 页（前后逐字节一致） | `context.service.ts:343-382` |
| 非分页大出参 | 超过 `toolResultCharLimit` 给模型"截断 + 明确提示"，**落库仍是完整原文** | `context.service.ts:383-403` |

- 页大小：`min(limits.pageBytes ?? spec.paginate.pageBytes, caps.pageBytesMax)`（`paginate.plugin.ts:32-35`）。
- 分页只有在**有 caller 且拿到 toolCallId** 时做；拿不到就不分页（宁可全量，`:29-30`）。
- `toolResultCharLimit = max(256, 窗口 × 0.1 × 2)`（`context.service.ts:158-165`）。
- **回取两条路**（`ToolResultStore.resolve`，`tool-result.store.ts:47-52`）：
  1. **同轮内存**（最多 200 条，LRU 淘汰，`:26, 40-43`）——必须有这一层，因为运行时**整轮结束后**才把出参落时间线（`:19-21`）；
  2. **跨轮 / 跨实例**：按 `(会话, toolCallId)` 查时间线原文（永久保留，是兜底也是真相）。
  不用 Redis：一轮粘在一个实例上（会话并发有部分唯一索引挡），少一个存储依赖。
- **取页工具自己走同一套网关**（`read-tool-result.tool.ts`）：句柄不属于当前会话 → `forbidden`（`:92-94`）；
  每轮取页次数上限 `maxPagesPerTurn`（Redis 计数，`:97-105`，超了 `rate-limited`）；原文查不到 → `precheck-failed`（`:108-114`）。

## 4. 并发与限额

**9 个插件的固定顺序**（`ai.module.ts:142-162`，数组顺序 = 执行顺序）：

```
pre:  enabled → scope → rate-limit → validate → precheck → audit-start
exec: spec.exec（异常/中止在这里兜成结论，永不外抛）
post: redact → paginate → audit-end        （拒绝也要跑 post，tool.gateway.ts:103-116）
```

- pre 链**任一给出结论即短路**（`tool.gateway.ts:90-98`）：所以顺序决定"用户看到哪个拒绝理由"；
  post 单个插件抛错只记 `ai.tool.plugin_failed`，不中断、不改变结论（`:106-116`）。
- 顺序不能换的三条理由：`redact` 必须在 `paginate` **之前**（否则第一页可能带明文，`redact.plugin.ts:9`）；
  `paginate` 必须在 `audit-end` **之前**（audit-end 记的是含分页的最终结论，`audit-end.plugin.ts:10`）；
  `audit-start` 必须在 exec **之前**（记 `startedAt` 与 `configVersion`，`audit-start.plugin.ts:9-12`）。
- `maxPerTurn`（`rate-limit.plugin.ts:19-36`）：按 run 计数 `ai:tool:turn:<runId>:<toolKey>`，TTL 3600，
  超了结论 `rate-limited` + `retryable: false`（本轮再试无意义）。
- `rateLimit`（`:37-58`）：按 `userId ?? conversationId ?? 'anonymous'` 计数
  `ai:tool:rate:<toolKey>:<subject>`，窗口 `windowSeconds`，超了 `retryable: true`。
- **窗口语义**：Redis `INCR` + 首次 `EXPIRE`（`tool.rate-counter.redis.ts:10-14`）→ **固定窗口**（从第一次调用起算），
  不是滑动窗口；多实例共享同一计数器（安全侧正确，代价是窗口边界可能有轻微尖峰）。
- **生效值与夹紧**（`tool.settings.ts:9-19, 36-50`）：`生效值 = env 上限夹紧(库里的值 ?? spec.config.parse({}) 默认值)`。
  `pageBytes` / `maxPagesPerTurn` 夹到 `caps`；**`maxPerTurn` 与 `rateLimit` 只做取整/透传，当前没有 env 上限
  （缺口）**——要上限就照 `caps` 的口径加一项并在 `clampLimits` 里夹。
- **多实例**：同一会话只允许一次进行中的**根**运行，由部分唯一索引挡（`run-entity.ts:25-28`
  `uk_run_active_conversation`）→ 一轮粘在一个实例上，同轮不会跨实例；限流计数在 Redis，跨实例一致。
- 命令能力是**两层关卡**：配置里的 `config.enabled` 与部署的 `caps.command.enabled` 都开才放行
  （`command.tool.ts:286-288`）。

## 5. 取消与超时

- **`ctx.signal` 怎么来的**：`POST /agent/run/stop` → 本进程 `abort.abort()`（`chat.service.ts:682-683`），
  运行在别的副本时经 Redis 停止频道广播给持有者（`:712-718`）→ 透传给 `agent.stream({ abortSignal })`（`:742`）
  与 requestContext（`:735`）→ 适配器塞进工具调用（`tool.adapter.ts:68`）→ 网关进 `ctx.signal`（`tool.gateway.ts:71`）。
- **命令超时**：`timeoutMs` **既是默认值也是硬上限**——模型传更小听模型的，传更大夹到配置（`command.tool.ts:229-233`），
  默认 15s（`:44`），`normalizeConfig` 再夹到 `caps.command.timeoutMsMax`（`:289`）。
- **结论文案**：`ToolDenyReasonValue` 9 个值（`tools.types.ts:195-204`）：
  `unknown-tool` / `invalid-input` / `precheck-failed` / `disabled` / `forbidden` / `rate-limited` / `timeout` /
  `aborted` / `internal`。执行体抛错时网关**先判中止**，给 `aborted`「这次调用已被停止」`retryable: false`
  （`tool.gateway.ts:128-130`）；`ToolDeniedError` 翻成它声明的 reason（`:131-140`）；其余一律 `internal`（`:141-149`）。
- **用户点停止后已生成的内容怎么保住**：`recorder.flushPending()`（`stream-recorder.ts:214-217`，把没有
  `*-end` 的 text / reasoning 落库）→ 中止分支先 flush 再抛（`chat.service.ts:809-812`），正常结束也兜一次（`:814`）；
  运行终态判 **`canceled` 而不是 `failed`**，并落一条带 `operator` 的 status 事件（`:916-927`）。
- 前端语义：`useChat().stop()` 只断本地连接，**必须**再调 `POST /agent/run/stop`（见 `develop-ai-agent` 的 runtime 参考）。

## 6. 崩溃恢复与流重放

- **恢复入口** `recovery.service.ts`（`OnApplicationBootstrap`）：未装配 Mastra 或 durable 关闭 → 跳过（`:68-75`）；
  Redis 租约 `agent:recovery:lease`（TTL 60s）**只有一个副本执行**（`:77-88`）；再调
  `mastra.recoverAllDurableAgents()`（`:92`）；恢复失败不是致命错，这一轮会被看门狗标超时、用户可重试（`:98-103`）；
  租约**故意不主动释放**（`:104-106`，避免释放瞬间另一副本重复恢复）。
- **多实例自检**：`AGENT_MULTI_INSTANCE=true` 但没配 `REDIS_URL` → **启动直接失败**（`:43-47`）——
  宁可起不来，也不要悄悄降级成"偶发断流、停止不生效"。
- **看门狗**：每 `watchdogIntervalMs` 一轮（`:51-57`）；`findStale` → **条件 UPDATE** 抢执行权
  （`affected !== 1` 说明别的副本先抢到，`:114-123`）；标记超时 + 落 status 事件（`:124-140`）。
  `markTimeout` 的判据必须与 `findStale` **完全一致**（见 `develop-ai-agent` runtime 参考）。
- **流缓存**（`stream-store.service.ts`）：进度 `agent:run:<id>`（TTL 6h，`:23, 32`）、输出记录
  `agent:stream:<id>`（List，TTL 1h、最多 20000 条，`:25, 34, 36, 114-115`）、跨副本 chunk / stop 频道（`:27-29`）。
  真相在 Postgres，**Redis 丢了只降级实时与补发**，不影响正确性（`:46-47`）。
- **重放**（`chat.service.ts:1012-1088`）：进度不在或不是 `running` → 返回 false，控制器回 **204**（`:1022-1023`）；
  从 `offset` 读输出记录补发（`:1028`）；**补发时把 `start` 块挪到最前**（`:1041-1045`）——否则 SDK 会先 push
  一条空消息，同一个回答在界面上出现两份；遇 `STREAM_END_MARKER` 直接收尾（`:1049-1057`）；否则挂住连接转发
  pub/sub（`:1061-1085`）。`resumeCurrentRun` 按**登录用户**找当前进行中的一轮（`:996-1004`），前端不必存 runId。
- **durable 下步骤元数据缺失的坑（踩过，现在有兜法）**：`agent.stream()` 在 durable 下返回
  `{ output, ... }` 包装对象，真正的 `MastraModelOutput` 在 `output` 里（`stream-result.ts:1-19`）；直接读
  `output.steps` 得到 `undefined`，`steps.entries()` 抛错会把**已经跑完并展示给用户的一轮判成 failed**
  （`stream-recorder.ts:220-225`）。兜法：`readStreamSteps` / `readStreamUsage` 兼容两种形态、**拿不到就是空**
  （`[]` / `undefined`，`stream-result.ts:33-41, 57-78`）+ `finish()` 自己兜住非数组（`stream-recorder.ts:229`）。
- **e2e 怎么钉**：`test/ai-stream-e2e.test.ts`（`durableEnabled: false`，覆盖 SSE 协议 / 停止 / 按 offset 补发 / 按用户续流）
  与 `test/ai-durable-stream.test.ts`（`durableEnabled: true`，**只盯 durable 收尾**：整轮成功、步骤行落库、
  轮次与标题更新，`ai-durable-stream.test.ts:41-56, 274-325`）。
- **恢复的代价**（引 `develop-ai-agent`）：会重发模型调用、重跑工具（钱重复花一次）；`recovery_count` 上限 1
  （`run-entity.ts:106-108`），子 run 靠 `uk_run_tool_call` 幂等复用（`:31-35`）。

## 7. 可观测

- **结构化日志事件命名** `ai.<域>.<动作>`，真实例子：`ai.tool.invoked` / `ai.tool.denied`（`audit-end.plugin.ts:38`）、
  `ai.tool.paged`（`paginate.plugin.ts:48`）、`ai.tool.rate_limited`（`rate-limit.plugin.ts:23, 44`）、
  `ai.tool.exec_failed` / `ai.tool.plugin_failed`（`tool.gateway.ts:142, 109`）、`ai.command.executed`（`command.tool.ts:259`）、
  `ai.context.compacted` / `ai.context.compact_failed`（`chat.service.ts:494, 502`）、
  `ai.context.window.unknown`（`context.service.ts:137`）、`ai.stream.succeeded` / `failed` / `canceled`（`chat.service.ts:877, 948, 927`）、
  `ai.watchdog.marked_timeout`（`recovery.service.ts:141`）、`ai.conversation.title_generated`（`title.service.ts:116`）。
- **审计**：`audit-start` 记 `configVersion` 与 `startedAt`（`audit-start.plugin.ts:9-12`）；`audit-end` 写旁证
  `{ok, reason, configVersion, durationMs, page, outputBytes}`（`audit-end.plugin.ts:28-35`）→ 由录制器合进
  `tool-result` 行的 `payload.outcome`（`stream-recorder.ts:119, 132`）；**拒绝也写**（`:103` 注释）。
  日志字段含 `conversationId` / `runId` / `userId` / `toolCallId` / `depth` / `configVersion`（`:39-50`）。
- **请求侧串联**：`runs.request_id`（`run-entity.ts:74-76`）把审计与日志 / 告警串起来；
  `request_snapshot` 记 model / agentKey / toolKeys / skillKeys / params / context（`chat.service.ts:844-851`）。
- **配置变更留痕**：行上的 `created_by` / `updated_by`（`packages/kits/src/db/audit-entity.ts:15-19`，由
  `AuditSubscriber` 自动填） + 一条 `ai.tool.config_updated` 日志；`ai_tools` **没有独立的审计表（缺口）**。
- **现状缺口：AI 模块未接 `telemetry` 统一入口** —— `grep -rn telemetry apps/server/src/modules/ai/` 无命中；
  现在只有结构化日志事件 + 用量落库（`runs.usage` / `timelines` 的 step 行），**没有 Counter / Histogram / 告警**。
  要看 QPS、错误率、P95、token 环比与 `surge` 告警，按 `telemetry` skill 埋点，并把指标口径写进设计文档。

## 8. 自查清单

- [ ] 新工具声明了 `paginate`（或能把出参收窄），不会一次把整棵目录树 / 全表灌进上下文？
- [ ] 新配置字段有 env 硬上限并在 `normalize` 里 `Math.min` 夹紧（`pageBytes` / `maxPagesPerTurn` 之外，
      自己加的旋钮自己夹）？
- [ ] 新限额的**结论文案与 `retryable`** 写清楚了（轮内限流是 false，时间窗是 true）？
- [ ] 用了 `ctx.signal`（长任务可被停止），并且中止后已生成内容能落库（不靠 `*-end`）？
- [ ] 出参里的重要结论不只在事件 / 对话正文里 —— 事件不落库、正文会被裁，结论必须在出参 / 计划里？
- [ ] 新工具的自定义事件有行数 / 条数上限，超限**如实报数**而不是静默丢？
- [ ] 失败 / 超时 / 取消路径都留了可排查的结构化日志（`ai.<域>.<动作>` 命名）？
- [ ] 改了上下文策略后，`runs.request_snapshot.context` 能解释这一轮给了什么、裁了什么、用哪条摘要顶替？
- [ ] durable 相关代码不依赖 `steps` 一定存在（拿不到就跳过步骤行，不把跑完的一轮判成 failed）？
- [ ] 需要指标 / 告警时，已经去 `telemetry` skill 埋点（AI 模块默认**没有**指标）？
