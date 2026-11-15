# bash 时长与文件写入上限：一条链上的 5 个值

> **查证优先级：必核** —— 改动 bash / 文件上限、调整部署 env 前必须复核（2026-11-15 实测）。

## 结论

- **bash 时长只有一个业务旋钮**：`ai_tools.bash.config.timeoutMs`（代码默认 300000 = 5 分钟，
  env `AGENT_COMMAND_TIMEOUT_MS` 是硬上限）。模型入参**没有** `timeout_ms`，传了会被 zod 丢掉。
- **远端链路上还有 4 个值必须 ≥ 目标时长，少抬一个就在那层被截**：
  runtime `tool.gateway.ts` 的 `deadlineMs`（310000）→ `TOOL_GATEWAY_DEADLINE_MS`（310000）→
  gateway `invokeTimeoutMs`（默认 310000 / 上限 360000）→ contracts `deadlineMs.max`（360000）。
  worker 再按 `deadlineMs - 500` 夹一次。
- **`CommandRunner` 还有 `MAX_TIMEOUT_MS = 5min`**：再往上调 bash 时长，先改这里，否则配置静默失效。
- **写文件两道检查**：`maxWriteBytes`（单次写入 / 替换 / 追加）与 `maxBytes`（单文件）都要 ≥ 目标；
  代码默认都是 10MB，env 是 `AGENT_FILE_WRITE_MAX_BYTES` / `AGENT_FILE_MAX_BYTES`，任一更小就夹回去。
- **已入库的工具配置不会被新默认值覆盖**：`upsertSeed` 保留 `existing.config`（种子行也保留旧值），
  改代码默认后必须同步改 `ai_tools.config`，或在后台逐项点「用默认值」。
- 模型单次内容入参仍受 `files.ts` 的 `max(1_000_000)` 字符限制，比 10MB 服务上限更早生效 ——
  大文件用 `append-file` 分段写。

## 核对命令

```bash
grep -n "default(300_000)" apps/agent-runtime/src/modules/ai/tools/bash.tool.ts apps/tool-worker/src/config/app-config.ts
grep -n "deadlineMs: 310_000" apps/agent-runtime/src/modules/ai/core/tools/tool.gateway.ts
grep -n "max(360_000)" packages/contracts/src/tool.ts
grep -n "MAX_TIMEOUT_MS" packages/kits/src/foundation/command/command.result.ts
grep -n "10 \* 1024 \* 1024" packages/ai-data/src/file/file.schemas.ts
PGPASSWORD=pg1234 psql -h localhost -U root -d billy-cli -At \
  -c "select tool_key, config->>'timeoutMs', config->>'maxWriteBytes' from ai_tools where tool_key in ('bash','write-file');"
```

## 失效信号

- 远端 deadline 改成按工具从 run 剩余预算派生（不再写死 310s）；
- `CommandRunner` 去掉 5min 上限，或 bash 改走后台 job / 会话沙箱；
- `upsertSeed` 的合并策略改成「默认值覆盖旧值」。
