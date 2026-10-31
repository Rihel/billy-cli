# AI 运行的观测三件套（首 token / 步与工具耗时 / 失败口径）

> **查证优先级：必核** —— 全是字段名、写入点与 SQL 口径。
> 用前先跑「核对命令」，对不上就现场改本卡。

## 结论（2026-10-29 落地）

- **首 token**：`runs.first_token_ms` 由流式路径写（`StreamRecorder.firstOutputAtMs` − `startedAt`）。
  **非流式拿不到**（`agent.generate` 结束才返回），保持 null —— 不编 0。
- **步耗时**：`timelines.duration_ms` 从 `start-step` / `finish-step` 的时间差写进 `kind='step'` 行；
  拿不到就不写。
- **工具耗时**：网关审计旁证 `ToolCallMeta.durationMs` 写进 `kind='tool-result'` 行的 `duration_ms`
  （以前只躺在 `payload.outcome` 里，列上永远为空）。`payload.outcome` 仍保留。
- **失败口径**：`tool-output-error` 按 `meta.reason` 分桶 —— 关掉 / 无权限 / 限流 / 前置条件不满足 →
  `state='denied'`，入参不合法 → `invalid`，其余 → `output-error`。工具把失败当结果返回
  （出参顶层 `ok:false`）→ 仍落 `output-error` + `isError:true`，客户端那份片段也换成 `tool-output-error`。
  **`ok:false` 的语义是"这次没做到"**；只是结果不合格请用 `valid` / `errors` 字段。
- **快照**：`request_snapshot` 在**调模型之前**落库（成功/失败/超时都有）；看门狗对没有快照的行补
  `{ failure: { stage, code, reason }, context: null }`。

## 核对命令

```bash
# 1) 写入点还在不在
grep -n "firstOutputAtMs\|durationMs: meta" apps/server/src/modules/ai/runtime/stream-recorder.ts
grep -n "prepareStep: this.buildPrepareStep" apps/server/src/modules/ai/runtime/chat.service.ts
grep -n "countProgress\|TimeoutReason" apps/server/src/modules/ai/runtime/run.repository.ts

# 2) 列上有没有数（跑过一轮真实对话后）
psql "$(sed -n 's/^DB_URL=//p' apps/server/.env)" -c \
  "select count(*) total, count(first_token_ms) first, count(duration_ms) dur, count(request_snapshot) snap from runs"
psql "$(sed -n 's/^DB_URL=//p' apps/server/.env)" -c \
  "select kind, count(*) total, count(duration_ms) has_dur from timelines group by 1 order by 2 desc"

# 3) 失败口径（denied / invalid 应开始出现）
psql "$(sed -n 's/^DB_URL=//p' apps/server/.env)" -c \
  "select state, count(*) from timelines where kind='tool-result' group by 1"
```

## 依据

- `runtime/stream-recorder.ts`（首 token / 步耗时 / 工具耗时 / denied / ok:false）
- `runtime/chat.service.ts`（`buildPrepareStep`、`firstTokenMs`、`toClientToolChunk`、`ensureFallbackTitle`）
- `runtime/turn-budget.ts`（轮内压工具结果，纯函数）
- `runtime/run.repository.ts` / `runtime/recovery.service.ts`（超时原因 + 进度回填 + 失败快照）
- 测试：`test/ai-stream-recorder-observability.test.ts`、`test/ai-turn-budget.test.ts`、
  `test/ai-stream-e2e.test.ts`（真 DB + 真 Redis + 假模型，断言 `first_token_ms` / 步耗时 / 快照）

## 失效信号

- 改走非流式做主业 → 首 token 恒为 null，要先把 `agent.generate` 换成 stream。
- Mastra 的 `prepareStep` 签名变了 → `turn-budget` 的接线要跟着改（纯函数本身不依赖 Mastra）。
- 把 `ok:false` 当"业务结论"用的工具 → 会被计成失败，应改用 `valid` / `errors`。
