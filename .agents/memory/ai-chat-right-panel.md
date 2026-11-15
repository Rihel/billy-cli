# 会话页右栏：四个 tab 的取数源与"子助手作用域"

> **查证优先级：必核** —— 取数路径 / 字段 / 快照机制类结论，改动 chat 目录或 agent-runner 后重核。

## 结论（2026-11-15）

右栏（`right-panel.tsx`）四个 tab 的主语**跟着主区 tab 条走**（`activeRunId`）：

| tab | 主会话 | 切到子 agent tab 时 |
| --- | --- | --- |
| 系统指令 | `POST /agent/instructions` 的会话快照 / 静态定义 | 同一接口传**子会话 id** → 我们交给子助手的完整指令（原稿 + 能力边界） |
| 技能 | 会话消息 parts 里 `skill` 工具调用 | 子 run 自己时间线派生（同一函数 `activatedSkillsOf`） |
| 任务 | `conversationPlanOf` 合流的当前计划 | `request_snapshot.task`（目标）+ 子 run 自己的 `plan` 事件 |
| 文件 | 根会话文件树 | **不切**：子助手写的就是父工作区 |

关键事实（不是猜测）：

- **子 agent 的系统指令 = 主 agent 现写的 `system_prompt` + 运行时追加的「能力与边界」尾巴**
  （`withCapabilityTail`）。起跑时把这份**最终文本**写一条 `kind=system` 的子会话时间线快照；
  `runs.request_snapshot.systemPrompt` 只有原稿（不含尾巴）。
- **快照 ≠ 模型最终收到的 system**：Mastra 在请求侧还会追加 `<available_skills>`（技能目录）
  和一段"技能不是工具"的说明（实测 2026-11-15，主会话同样如此）；快照里没有这两段。
- `instructions` 必须**先读快照、后查 agent 目录**：子 agent 的 key 是 `sub:<名字>`，不在目录里，
  先 `resolveAgentKey` 会抛 3303（子会话页的「系统指令」曾一直报错）。
- 没快照的子会话回 `source='unrecorded'`（`instructions` 空串），前端用 run detail 里的原稿兜底并注明。
- 子 agent **有任务清单**：planner 组 `child: 'allow'`，作用域按**会话**（子会话 = 自己那份），
  plan 事件落在子会话时间线，**不走父会话的流** —— 要看"边做边变"必须轮询时间线。
- 右栏复用主区 `SubRunView` 的同一个时间线 queryKey（`['ai','timeline',conversationId,'run',runId]`），
  两边共享一份缓存，不重复请求。

## 依据

- `apps/admin/src/app/(app)/(standalone)/main/ai/chat/right-panel.tsx`（`useSubAgentScope`）
- `apps/agent-runtime/src/modules/ai/runtime/agent-runner.ts`（`withCapabilityTail` + 子会话系统快照）
- `apps/main/src/modules/ai-admin/conversation/conversation.service.ts`（`instructions` 取数顺序）
- `apps/agent-runtime/test/ai-plan-subagents.test.ts`（快照内容与 seq 顺序）、
  `apps/main/test/ai-instructions-subagent.test.ts`（3303 回归）

## 核对命令

```bash
grep -n "withCapabilityTail\|kind: TimelineKind.System" apps/agent-runtime/src/modules/ai/runtime/agent-runner.ts
grep -n "unrecorded\|latestSystemPrompt" apps/main/src/modules/ai-admin/conversation/conversation.service.ts
grep -n "activeRunId\|useSubAgentScope" "apps/admin/src/app/(app)/(standalone)/main/ai/chat/right-panel.tsx"
```

## 失效信号

- 子 agent 改成有静态提示词模板（那时"快照优先"的前提变了）；
- `request_snapshot` 改成存最终文本（前端就不需要 unrecorded 兜底）；
- 子 agent 的 plan 改成经父流推送（那时不需要轮询时间线）。
