# 工具副作用台账（ai_tool_effects）

> 落地方案 + 语义定义。回应评审「恢复重放的工具副作用语义需要明确」这一条，
> 与 `docs/design/ai-agent.md` §3.4（工具幂等是崩溃恢复的硬前提）配套阅读。

## 1. 要解决什么

durable run 崩溃恢复会**重放同一个工具调用**（Mastra 从上一个快照继续，历史消息里的
`toolCallId` 不变），于是同一个副作用可能被执行两次：

- 模型调用重发：只是多花钱；
- 工具重跑：`bash` 写文件、发消息、删数据 —— 重跑一次就是一次真实的重复副作用；
- 进程在「请求已发出、响应没回来」时挂掉：恢复时**不知道**它到底执行了没有。

因此需要的不是「让工具变成幂等」（做不到），而是：**每个有身份的调用最多生效一次，
判不出来时如实报 unknown，而不是猜成功或猜失败。**

## 2. 结论：调用身份 = `(runId, toolCallId)`

| 事实 | 来源 |
| --- | --- |
| runtime 已经把它当幂等键往下传 | `apps/agent-runtime/src/modules/ai/runtime/remote-tool.client.ts`（`idempotencyKey: toolCallId`） |
| 网关原样转发 | `registry/service.invoker.ts` |
| 服务侧此前只拿它记审计 | `apps/{common,workspace}-capability/src/**/invoke.controller.ts` |

也就是说链路早就通了，缺的只是**去重与状态**。台账放在**能力网关**（所有工具调用的唯一收口），
不放在每个服务里各写一套。

## 3. 数据结构

`packages/db/src/entities/ai-tool-effect-entity.ts`（表 `ai_tool_effects`）：

| 列 | 含义 |
| --- | --- |
| `run_id` + `tool_call_id` | 调用身份；`uk_ai_tool_effect_run_call` 唯一（`WHERE deleted_at IS NULL`） |
| `capability` | 规范 key |
| `request_hash` | 规范化入参的 sha256 前 32 位（递归排序 key，避免键序误判冲突） |
| `status` | `dispatched` / `completed` / `failed` / `unknown` |
| `attempts` | 派发次数（每次合法重试 +1，用于观测「同一个调用跑了几次」） |
| `deadline_at` | 本次派发期限；过期未结算即可判 unknown |
| `outcome` / `result_bytes` | 结论快照（≤ 32KB 才存完整结论，超限只记大小） |
| `settled_at` | 结算时间 |

不存入参明文（参数全文在 timelines），不提供删除能力（台账是证据）。

## 4. 状态机与分级

```
          begin()                         settle(ok)            → completed
调用 ──► dispatched ──┬──────────────────► settle(失败)          → failed
                      └─ 超期未结算 ──────► unknown
```

**能力分级直接复用契约里已有的两个字段**（不新造概念）：

| `risk` | `idempotent` | 语义 | 同键再次调用 |
| --- | --- | --- | --- |
| `read` | 任意 | 只读 / 纯计算 | 允许重跑（最多多花一次查询） |
| `write` | `true` | 幂等写（服务端按幂等键去重） | 允许重跑 |
| `write` | `false` | **不可逆副作用** | **永不自动重跑** |

不可逆能力面对历史状态时：

| 历史状态 | 处置 |
| --- | --- |
| `completed` 且结论留存 | 直接返回历史结论（`replay`），不再执行 |
| `completed` 但结论超限未留存 | `effect-result-unavailable`：请用只读能力核验，不要重复执行 |
| `failed` 且结论留存 | 返回那次失败结论 |
| `dispatched` 未过期 | `effect-in-flight` |
| `dispatched` 已过期 / `unknown` | `effect-unknown`：已派发但结论未知，不重跑 |
| 同句柄但 `request_hash` 不同 | `effect-conflict`：上下文被改写，拒绝执行 |

只读与幂等写在这些状态下都可以重跑，走 `attempts + 1` 的条件写（CAS）。

## 5. 并发与失败边界

- **首次认领**：唯一索引 + 插入冲突，只有一个执行者拿到 `proceed`；
- **重试认领**：`UPDATE ... WHERE status = 旧状态 AND attempts = 旧值`，抢不到报 in-flight；
- **结算**：只写 `status = 'dispatched'` 的行 —— 已经判成 `unknown` 的不会被迟到的响应覆盖；
- **台账不可用**（DB 抖动）：只读能力放行并告警；**写入类能力直接拒绝**（`effect-ledger-unavailable`）。
  理由：宁可这次调不通，也不要留下一个事后查不出来的副作用。

## 6. 明确不做的

- **不承诺 exactly-once**：跨外部系统的真正一次语义无法由网关单方面保证，这套机制的目标是
  「可检测、可恢复、尽可能幂等」，不是「绝不重复」；
- **不做结果全文留存**（> 32KB 只记大小）：结论正文本来就在 timelines 与服务日志里；
- **不做自动「事后对账」**：`unknown` 的核验交给上层的只读工具或人，网关不猜测外部系统的状态。

## 7. 测试点

| 用例 | 位置 |
| --- | --- |
| 首派 → 结算 → 重放复用结论；未结算不重复派发 | `apps/capability-gateway/test/tool-effect.ledger.test.ts` |
| 同句柄换参数 → 冲突 | 同上 + `tool-effect.decision.test.ts` |
| 不可逆超期 → unknown（含状态落库）；幂等写超期 → 重试且 attempts+1 | 同上 |
| 结论超限 → `effect-result-unavailable`，只读能力仍可重跑 | 同上 |
| 并发认领只放行一个 | 同上 |
| 分级判定矩阵（只读 / 幂等写 / 不可逆） | `tool-effect.decision.test.ts` |
