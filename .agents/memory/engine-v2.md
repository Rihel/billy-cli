# engine v2：RunExecutor / RunExecution / 能力接缝

> **查证优先级：必核** —— 关键文件、开关与事件形态；改 `engine/` 或 `chat.service` 后重核。

## 结论（2026-11-28）

- v2 开关 `AGENT_ENGINE_V2`（默认 `true`）：`app-config.ts` → `AgentConfig.engineV2`；
  `false` 时 `RunExecutor` 直接把命令转给 `AgentChatService`（旧的直写 response 路径）。
- `RunExecutor.start/resume` 返回 `RunExecution`（`events` + `result`）；`RunEventSink`
  把执行体写的 SSE 帧收成 `AsyncIterable`。执行体 `emitAgUi` 出来的是 encode 后的
  `RUN_FINISHED`，**不是** `__run_end__` 裸帧；sink 的 marker 分支只兜底补发 / 测试。
- 能力接缝 token 在 `engine/tokens.ts`，适配器在 `engine/adapters/*`；`chat.service` 用
  `streams` / `toolFace` getter 回落到具体服务 —— 手工构造（测试 / 脚本）不注入端口也照常跑。
- `MastraModelClient` 包装 AI SDK 实例；`resolveModelInstance` 返回它，执行体把
  `mastraInstance` 传给 `agent.stream({ model })`。
- 薄 `MastraAgentLoop` 用 ModelClient + Toolbox 真跑循环，但**不接主路径**（S1 保留 Mastra
  循环算法）；`resume` 直接抛 `run_not_resumable`，不假装支持 durable 快照。
- 观测：`EngineTelemetry` 输出 `engine.run.*` 事件与 `engine_*` 指标；恢复服务在
  `recoverOnBoot` 成功后逐条记 `engine.run.recover`，启动清理 / 看门狗标 interrupted 也记。
- `x-request-id` 链路已打通：main 转发 → controller 放进命令体 → `chat.startRun` 写
  `runs.request_id`；用户排队消息的 payload 保留 requestId，调度起跑时继续写。
- `engine/run-state.ts` 是纯状态机（`canTransitionRunState` / `isTerminalRunState`），
  只做判断、不改落库；落库仍靠 `RunRepository` 条件更新与 `uk_run_active_conversation`。

## 依据

2026-11-28 第二轮落地；`apps/agent-runtime/test/engine-*.test.ts` 6 个文件覆盖。

## 核对命令

```bash
ls apps/agent-runtime/src/modules/ai/engine apps/agent-runtime/src/modules/ai/engine/adapters
grep -n "engineV2" apps/agent-runtime/src/app-config.ts apps/agent-runtime/src/modules/ai/core/config.ts
grep -n "engine.run.start\|engine_run_start" apps/agent-runtime/src/modules/ai/engine/engine-telemetry.ts
cd apps/agent-runtime && pnpm exec vitest run test/engine-
```

## 失效信号

移除 `AGENT_ENGINE_V2` / 端口 getter 被删 / `MastraAgentLoop` 改为默认主路径 /
`MastraModelClient` 不再包 AI SDK 实例；任一出现回来改卡片。
