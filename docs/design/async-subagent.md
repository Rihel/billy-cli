# 异步子 agent 与会话 run 队列（方案稿）

> 状态：**草案，待评审**（2025-11-15）
> 目标：把子 agent 从「同步工具调用」改成「异步执行 + 完成唤醒」，并给父会话加一条
> 用户优先、子 agent 完成串行的 root run 队列。
>
> 本文只回答「怎么设计」；未评审前不落代码。

## 1. 现状与问题

现在 `run-sub-agent` 是**同步工具**：

```
父模型 → run-sub-agent(systemPrompt, task)
        └─ 子 run 在同一个工具调用里跑完
        └─ SubAgentOutcome 作为 tool result 返回
父模型拿到结果 → 下一步
```

带来的限制：

- 父模型在子跑完之前不能继续规划或调别的工具；
- 子不能比父 run 活得久；
- 父看不到子运行中的结果（只有 UI 的 `data-sub-agent` 事件）；
- 同一父 run 的多个子可以并发，但父要等整步工具返回。

目标改成：

```
父 run → run-sub-agent(...) 立即返回 subAgentId
父继续干活 / 或结束这一轮
子 A/B/C 异步执行
子 agent 完成 → 结果入父会话队列
队列按「用户优先、子 agent 逐条」串行起新的父 run
父新 run 带着子结果继续
```

## 2. 已确认的口径（评审时先看这一节）

| 问题 | 决定 |
| --- | --- |
| 用户消息 vs 正在跑的 run | 用户消息**等当前 run 结束**，不抢占 |
| 多个子 agent 完成 | **逐条**唤醒，不攒批 |
| 父子 planner | **各自独立**；子 agent 可用 planner |
| 子 agent生命周期 | 父**正常结束**→子继续；用户 stop / 父失败 / 删会话→**级联取消** |
| 队列存储 | **新表**，不复用 `runs` 的 status |
| 唤醒 run 的可见性 | 时间线先有「子 agent 完成」系统卡，再是父的正常回复；前端自动续流 |
| 检查完成情况 | 不单独做轮询工具；`sub-agent-list` 非阻塞、`wait-sub-agent` 支持 timeout |
| 工具命名 | `run-sub-agent` / `sub-agent-list` / `wait-sub-agent` / `cancel-sub-agent` |
| `run-sub-agent` 语义 | **直接改成异步**（保留 key，不新增另一套派发工具） |

## 3. 数据模型

### 3.1 新表 `conversation_run_queue`

```sql
CREATE TABLE conversation_run_queue (
  id              varchar(20) PRIMARY KEY,
  conversation_id varchar(20) NOT NULL,
  source          varchar(16) NOT NULL,   -- user | subagent
  priority        smallint NOT NULL,      -- user=0, subagent=1
  status          varchar(16) NOT NULL,   -- queued | dispatching | started | done | canceled | failed
  dedupe_key      varchar(80),            -- 子 run 完成用 childRunId；用户消息可空
  payload         jsonb NOT NULL,         -- user: {body, clientId, requestId}；subagent: {childRunId, parentRunId, subAgentId, summary, result, error}
  run_id          varchar(20),            -- 实际创建出来的 root run
  error           text,
  created_at      timestamp(3) NOT NULL,
  started_at      timestamp(3),
  finished_at     timestamp(3)
);

CREATE UNIQUE INDEX uk_run_queue_dedupe
  ON conversation_run_queue (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX idx_run_queue_dispatch
  ON conversation_run_queue (conversation_id, status, priority, created_at);
```

约定：

- `subAgentId` = 子会话 id；`subRunId` = 子 run id；
- 子 agent 完成 `dedupe_key = childRunId`，保证 Kafka/Redis 重复投递只入队一次；
- 队列项是**运行调度记录**，不是审计正文；`done/canceled` 超过 7 天可清（runs/timelines 不删）。

### 3.2 子 agent 的身份 = 子会话

- `subAgentId` = 子会话 id（`conversations.kind='subagent'`）；
- `subRunId` = 子 agent 当前这次执行的 run id；
- 一个子 agent 可以有多条 run（重试 / 恢复），所以工具和队列用 `subAgentId` 指 agent，
  用 `subRunId` 指某一次执行；
- 完成队列的 `dedupe_key` 用 `subRunId`（一次执行只唤醒一次）。

### 3.2 `runs` 增加来源

`runs` 增加可选 `origin`：

```
origin varchar(16) NOT NULL DEFAULT 'user'  -- user | subagent
```

唤醒 run 仍是 `parent_run_id = NULL` 的 root run，但 `origin='subagent'`，
UI/审计能区分「用户发起」还是「子 agent 完成唤醒」。

`request_snapshot` 里同时留 `{ origin, childRunId, subAgentId, childConversationId, summary }`。

## 4. 队列调度

### 4.1 状态机

```
queued ──dispatch──> dispatching ──create run──> started ──run finish──> done
   │                      │
   │                      └─create failed──> failed（最多重试 1 次）
   └── cancel（用户 stop / 子 agent 取消 / 删会话）──> canceled
```

- 同一会话**同一时刻只有一个 root run**（现有 `runs` 唯一索引兜底）；
- 调度器只在会话空闲时取队首；
- 取队首用 Redis 锁 `ai:run:queue:<conversationId>` + DB 事务，防多副本抢同一条；
- `started` 表示 run 已创建；run 的最终状态在 `runs` 里；
- 启动时清理：`dispatching` 超过 2 分钟且没有 `run_id` 的项重置为 `queued`；
- `dispatching` 有 `run_id` 但 run 已是终态：按终态补 `done/failed`。

### 4.2 排序与优先级

```
ORDER BY priority ASC, created_at ASC
```

- `user`（0）永远先于 `subagent`（1）；
- 同优先级 FIFO；
- 用户消息在当前 run 跑完后才会被取；
- 子 agent 完成唤醒在用户消息之后逐条执行。

### 4.3 触发点

| 事件 | 动作 |
| --- | --- |
| 用户发消息 | 入队 `user`；若会话空闲立即 dispatch |
| 子 agent 成功/失败 | 入队 `subagent`（dedupe=childRunId）；若空闲 dispatch |
| 任意 root run 结束 | `dispatchNext(conversationId)` |
| 用户 stop / 父 run 失败 | 取消该父 run 的所有子 agent + 该会话所有 `subagent` 队列项；不取消用户消息 |
| 删除会话 | 取消全部队列项 + 子 run |

## 5. 工具契约

### 5.1 `run-sub-agent`（改异步）

```
input:  { name, systemPrompt, task }
output: { subAgentId, subRunId, conversationId, status: 'running' }
```

- 立即返回，父不阻塞；
- 子 run 创建后由独立执行器跑，父 run 的 abort 不直接取消它；
- 失败不抛异常，作为子 agent 状态返回（父可用 list/wait 看）；
- 仍受深度/每 run 子 agent 上限/并发闸门约束。

### 5.2 `sub-agent-list`

```
input:  { status?, limit? }
output: { agents: [{ subAgentId, conversationId, currentRunId?, name, agentKey, status, resultSummary?, error?, createdAt, finishedAt? }] }
```

- 只列当前父会话（或当前 root conversation）下的子 agent；
- 不消费结果、不触发唤醒；
- `resultSummary` 截断，完整结果用 `wait-sub-agent`。

### 5.3 `wait-sub-agent`

```
input:  { subAgentIds?, mode?: 'any' | 'all', timeoutMs?: number }
output: { agents: SubAgentResult[], pending: string[], timedOut: boolean }
```

- 父还在跑、想主动收口时用；
- 默认 `mode='all'`；`timeoutMs` 到点返回 pending，不算失败；
- **消费队列项**：如果该 childRunId 已有 `subagent` 队列项，原子标记 `done`，避免父 run 结束后再唤醒一次；
- 已经在父 run 结束时消费过的结果不再重复。

### 5.4 `cancel-sub-agent`

```
input:  { subAgentId }
output: { canceled: boolean, status }
```

- 取消子 run；同时取消该 childRunId 的队列项；
- 幂等；子已终态返回当前状态。

### 5.5 工具权限

- 子 agent 仍然**不能** `run-sub-agent`（深度 1）、不能 `ask-user-questions`；
- `planner` 组从 `child: 'deny'` 改为允许，子 plan 存子会话/子 run，父 plan 独立；
- 父 agent 的四个子 agent工具都按 `child: 'deny'`（子不能管别的子 agent）。

## 6. 完成唤醒 run

### 6.1 事件与入队

子 run 结束（成功或失败）时：

1. 写 `runs` 终态、时间线、usage（现有逻辑）；
2. 发出内部事件 `ai.subagent.completed`（Kafka 或 Redis EventBus，payload 含 childRunId / parentRunId / parentConversationId / status / resultSummary / error）；
3. 队列消费者幂等插入 `conversation_run_queue`（source=subagent, dedupe=childRunId）。

用户 stop / 父失败 / 删会话导致的子取消**不入队**。

### 6.2 新建父 run

调度器取出 subagent 队列项后：

- 在父会话创建 root run（`parent_run_id = NULL`, `origin = 'subagent'`）；
- 输入构造：
  - 时间线先写一条 `system` 卡片：`子 agent {name} 完成` + 摘要 + 子会话链接；
  - 给父模型的上下文里加入一条**内部系统通知**：`子 agent {name} 已完成：{result}`（失败则是错误原因）；
  - **这条通知的角色是 `user`，不是 `system`**（2026-11-15 修正：模型只把「最后一条 user」当成
    这一轮要回应的任务；走 system 时它会回退到最近的 user 消息 —— 会话开头那条原问题 ——
    把「子助手完成」误判成「用户重复提问」，实测一次会话连续误判 4 次、多烧约 220 万 token）。
    「不是用户说的」由**首尾两处加粗文案**承担：`**［内部系统通知 · 不是用户的新消息］**` +
    `用户没有再看新消息：不要把这当成「用户重复提问」`；
  - 通知里带**同批进度**：`{ total, completed, pending[] }`（还有谁在跑），由引擎在入队时算好；
  - 父模型正常流式输出；
- **每完成一个子助手就唤醒一次**（不做批次聚合，2026-11-15 定）：父模型拿到第一个结果就能开始推进，
  不必等最慢的那个；「还有谁在跑」由通知里的进度给出，它不用自己数（数错就会提前写汇总）；
- 提示词（`assistant.eta` 的「编排子助手」段）明确教了这条语义：一次派出去、派完继续做、
  每个完成都会通知、还有在跑就别提前汇总、要主动等用 `wait-sub-agent`；
- 这一轮**不在时间线写用户消息**（只写系统卡），但发给模型的收尾消息是 `user` 角色 ——
  「时间线证据」与「模型输入」是两件事，不要混为一谈；
- 如果父模型在 `wait-sub-agent` 里已经拿过同一结果，队列项已消费，不会再建 run。

### 6.3 UI 与流

- 新 run 启动时发 `conversation.run.started`（`ai:owner` 频道或现有 run 状态流）；
- 前端收到后：如果当前正在看该会话，自动 `resume` 续流；如果不在，显示未读/通知；
- 时间线系统卡与父回复都在同一个会话里；
- 子结果全文默认不灌进父卡片，只给摘要 + 「打开子会话」。

## 7. 生命周期与失败

| 场景 | 行为 |
| --- | --- |
| 父 run 正常结束 | 子继续；完成后入队 |
| 用户 stop 父 run | 级联取消子 run；删除该父 run 的 subagent 队列项 |
| 父 run 失败（看门狗/模型错误） | 同上 |
| 子 run 失败 | 入队唤醒父，父决定重试/改方案 |
| 子 run 被 cancel | 不入队；删除对应队列项 |
| 删会话 | 取消所有子 run + 清队列 |
| 父 run 恢复/重启 | 现有 recovery 逻辑；队列项 `dispatching` 超时重置 |

## 8. 限制与可观测

- 每父 run 同时子 agent数沿用 `SUB_AGENT_MAX_CONCURRENT` / `maxPerRun`；
- 每会话队列长度上限（建议 50），超限拒绝并返回明确错误；
- 队列深度、等待时长、唤醒失败次数进 telemetry / 日志：
  `ai.run_queue.enqueued|dispatched|empty|dispatch_failed`；
- `dedupe_key` 唯一索引兜底重复投递；
- 队列项不含敏感字段摘要之外的完整 tool 输出？结果 payload 需要落库给父 run，按 DB 权限控制。

## 9. 分阶段实施

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P1 | 表 + 队列服务 + 调度器 + 用户消息入队/优先级 | 用户消息在忙时排队，按序执行 |
| P2 | `run-sub-agent` 异步 + `list/wait/cancel` + 子 agent 完成入队 | 父派子 agent 后结束，子 agent 完成后队列有项 |
| P3 | 唤醒 run + 系统卡 + 前端自动续流 | 子 agent 完成后父自动新 run 并显示 |
| P4 | planner 放开给子 agent + UI 子 agent 状态 | 子可规划；父可看子状态 |
| P5 | 故障恢复、队列清理、指标与测试 | 重启/重复事件/取消路径通过 |

## 10. 待评审

1. ~~唤醒 run 的父输入用内部 system 消息是否接受？~~ **已决（2026-11-15）**：改 `user` 角色 +
   首尾文案标注「不是用户的新消息」。理由见 §6.2 —— system 收尾会让模型找不到触发源，
   把「子助手完成」误判成「用户重复提问」。
2. 子 agent 失败也唤醒父，还是只成功唤醒？
3. 队列项 `done/canceled` 7 天清理是否接受？
4. `wait-sub-agent` 消费队列项后，父 run 结束时不再唤醒——这个语义是否接受？
5. 子 agent 的 planner 独立后，父是否需要在 UI 只读查看子 plan？
   **部分已决（2026-11-15）**：清单作用域 = `envelope.conversationId`（不是 `parentRunId`）。
   父 run、它的唤醒 run 共用父会话那份；子 agent 用子会话那份，互不覆盖。
   曾用 `parentRunId` 作键，父子撞同一份内存清单，四个子助手互相覆盖任务 id（实测 t1 重复）。
