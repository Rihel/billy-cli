# 工具副作用台账（ai_tool_effects）

**查证优先级：必核**（改网关调用链 / 契约的 `risk`·`idempotent` / 台账表结构后重核）

## 结论（2026-11-22 落地）

- **调用身份 = `(run_id, tool_call_id)`**：runtime 的 `remote-tool.client` 一直把 Mastra 的
  `toolCallId` 当 `idempotencyKey` 往下传，此前只被服务侧当审计字段用，**没有去重**；
  现在网关在 `CapabilityRegistryController.invoke` 里用 `ai_tool_effects` 认领 / 结算。
- **分级复用契约既有字段**，不新造：`risk='read'` 或 `idempotent=true` → 可重跑；
  `risk='write'` 且 `idempotent=false` → **永不自动重跑**（派发过就如实报 `effect-unknown`）。
- **但「未知态」是另一条线**：`unknown` / 派发超期时**只有只读能重跑**，写类（含幂等写）一律
  `effect-unknown` 等核验 —— 超时不等于执行结束，幂等只表示「业务上重复可接受」，
  不代表下游有并发去重能力。
- **两张表**：`ai_tool_effects`（当前状态，`(run_id, tool_call_id)` 一行）+ `ai_tool_effect_attempts`
  （每代一行，`(effect_id, generation)` 唯一）。重派发会清主表 `outcome`，但历史行的归档结论
  必须留着 —— 不然「第一代到底执行过没有」永远答不出来。
- **状态机**：`dispatched → completed | failed | unknown`；`begin()` 的过期判断是**懒判**，
  另有 `ToolEffectSweeper` 每 60s 兜底扫描（以主表为准，把对应历史行一起转 unknown）。
- **派发代际（= `attempts`）**：`begin()` 返回 generation，`settle()` 必须带回，只写
  `status='dispatched' AND attempts=<generation>` 的行；否则旧代的迟到响应会结算到新一代上
  （2026-11-22 复审抓出的 P0，已修）。`unknown` 之后的迟到响应只**归档**结论，不改状态。
- **没有 `idempotencyKey` 就不进台账**（建不出「同一次调用」的身份），按普通调用处理。
- **台账写不进去时**：只读能力放行 + 告警；写入能力直接拒绝（`effect-ledger-unavailable`）。
- 结论正文 ≤ 32KB 才留存；超限只记 `result_bytes`，重放时报 `effect-result-unavailable`。
- **task 型调用**：`settle()` 把下游任务号落进两张表的 `task_id`（**与结算代际解耦**：
  旧代迟到被判 `stale` 也照样写）；`/v1/tasks/cancel-run` 取
  「Redis `ai:capability:run-tasks:<runId>` ∪ 台账 `taskIdsForRun`（默认 6h，按 `updated_at` 算）」并集，
  查询失败返回 `degraded: true`；
  兜住 Redis 映射丢失导致取消不到任务。不可恢复窗口：进程死在「提交成功、拿回任务号」之间。
- 设计（状态机全表、并发边界、明确不做的）见 `docs/design/tool-effect-ledger.md`。

## 踩坑

- **TypeORM `dataSource.query()` 对 DML 返回 `[rows, affected]`，不是 rows 数组**：裸写
  `rows.length` 恒为 2，把「一行都没更新」当成「更新成功」。CAS / 租约释放 / 快照命中的判断
  全都会失真（`run_ownership` 的 `releaseRunOwnership` 与 `persistWorkflowSnapshot` 就这么错过）。
  统一用 `@repo/kits` 的 `affectedRowsOf()` 读结果（`packages/kits/src/db/dml-result.ts`）。

- **唯一索引必须带 `WHERE deleted_at IS NULL`**：实体继承 `BaseEntity`（有软删列），把
  `deleted_at` 放进唯一键在 PG 下挡不住重复（NULL 互不相等）。
- **jsonb 列不要用 `repo.update` 写结论**：TypeORM 的 `DeepPartial` 会把 `unknown` 字段收紧成
  `{(...): string | undefined}`，`data: unknown` 直接类型不通过；台账的写入统一走 raw SQL
  （`db.dataSource.query` + `$4::jsonb`），与 `run_ownership` 同风格。

## 依据

- `packages/db/src/entities/ai-tool-effect-entity.ts`、迁移 `1795331980277-AddToolEffects.ts`
- `apps/capability-gateway/src/effects/{tool-effect.types,tool-effect.ledger,canonical-hash}.ts`
- `apps/capability-gateway/src/registry/capability-registry.controller.ts`（claim / settle 接线）
- 测试：`apps/capability-gateway/test/tool-effect.{decision,ledger}.test.ts`

## 核对命令

```bash
psql "$DB_URL" -c '\d ai_tool_effects'
grep -n "claimEffect\|settleEffect" apps/capability-gateway/src/registry/capability-registry.controller.ts
pnpm --filter @app/capability-gateway exec vitest run test/tool-effect.ledger.test.ts
```

## 失效信号

工具实现不再走网关（本地直连服务）/ 服务侧开始自己写 `ai_tool_effects` / 契约改名
`idempotencyKey` / Mastra 重放时换了 toolCallId（那时身份不再是原调用）。
