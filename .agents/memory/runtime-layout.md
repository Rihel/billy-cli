# runtime 目录布局与 chat.service 拆分

> **查证优先级：必核** —— 目录结构 / chat.service 行数 / 抽出的模块位置；改 runtime 目录后重核。

## 结论（2026-11-28）

- `modules/ai/` 顶层按职责分组：`api/`（Host 适配）、`engine/`（协议/执行/接缝）、
  `runtime/`（一轮执行编排）、`domain/`（agents/files/memory/skills）、
  `tools/`（engine=DSL/注册机/网关/插件，builtin=具体工具与规划，skills=技能加载/目录/种子）、
  `adapters/`（mastra/storage）、`foundation/`（config/constants/errors/envelope/model*/prompts）。
- `runtime/` 已按域分目录（39 个平铺文件 → 10 个子目录）：
  `agent/`（chat.service、agent-runner、step-persister、turn-watchdog）、
  `attachments/`、`common/`、`context/`（context.service、turn-budget、message-snapshot、
  conversation-summarizer、runtime-context.builder）、`conversation/`（repository/service/title/first-turn-title）、
  `model/`、`queue/`、`run/`（repository/service/snapshot/status/recovery/usage/usage-roller/timeline）、
  `stream/`（store/recorder/deltas/resume/result/response/agui-emitter）、`subagent/`、`workspace/`、`storage/`。
- `chat.service` 从 3847 → 约 2616 行：抽出的模块都是**无 DI 的模块函数**或轻量类，
  chat 在构造后/调用点传现有实例（`titleDeps` / `summarizerDeps` / `runtimeContextDeps` / `snapshotDeps`），
  没有改构造参数顺序，手工构造的测试不受影响。
- 三条流式路径的看护已统一到 `TurnWatchdog`（心跳续租 + 首 token 超时 + 首 token 观测）；
  首轮 / 续跑 / 无头队列各自的定时器与标记位已删。
- 「chunk 录制 + 发射 + 进度」已收敛到 `TurnChunkPump`（首轮 + 无头队列共用）。
- 收尾三态都已收敛到 `turn-finalizer.ts`：`finishSucceededTurn`（首轮 / 队列 / 续跑）、
  `finishFailedTurn`（timeout / canceled / failed）、`finishSuspendedTurn`（首轮 / 队列）。
- 准备阶段收敛到 `turn-preparer.ts`：`prepareTurn`（模型 → 上下文 → 快照 → 用户消息）与
  `prepareRuntime`（运行时信封 + memory thread）两段，非流式 / 首轮 / 队列三条路径共用。
- 非流式 `chat()`、`resumeChat` 的成功 / 再次挂起也都接同一组 finalizer；
  只剩 `resumeChat` 的失败收尾保留独立实现（不写 timeline、不级联取消，语义与首轮失败不同）。

## 依据

2026-11-28 目录整理与拆分；`pnpm --filter @app/agent-runtime test` 589 条全绿。

## 核对命令

```bash
find apps/agent-runtime/src/modules/ai/runtime -maxdepth 2 -type d | sort
wc -l apps/agent-runtime/src/modules/ai/runtime/agent/chat.service.ts
grep -n "class AgentChatService" apps/agent-runtime/src/modules/ai/runtime/agent/chat.service.ts
cd apps/agent-runtime && pnpm exec vitest run test/ai-stream-e2e.test.ts
```

## 失效信号

chat.service 又涨回 3.5k / runtime 根目录重新出现平铺业务文件 / 抽出的模块又把 DI 依赖塞回 chat 构造。
