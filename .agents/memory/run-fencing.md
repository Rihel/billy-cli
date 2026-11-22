# durable run 的 run fencing（防多副本双写）

**查证优先级：必核**（改 `run_ownership` 表 / `AgentWorkflowsStorage` 的 ownership 方法后重核）

## 结论（2026-11-22 落地）

- `AgentWorkflowsStorage` 声明 `supportsRunFencing() = true`，所有权记录在 `run_ownership`
  （`run_id` PK、`owner_id`、`generation`、`lease_expires_at`、`updated_at`，无软删 / 无外键）。
- `claimRunOwnership` 用 `INSERT ... ON CONFLICT` 原子抢占：无记录时插入（generation 取 DB 时钟毫秒，
  至少 1），有记录时 lease 过期 / force 才允许递增 generation；`renew` / `release` / `get` 同表。
- 快照与步骤写入带 `fence` 时校验 `owner_id + generation` 且租约未过期；旧执行者拿旧 generation
  写入抛 `RunFenceConflictError`，不会落库。
- 恢复外层租约仍保留（只减少重复扫描），**正确性靠 per-run fencing**；租约过期 / 后台继续跑时旧执行者
  的写入会被拒绝。

## 依据

- `packages/db/src/entities/run-ownership-entity.ts`
- `packages/db/src/migrations/1795318386890-RunOwnership.ts`
- `apps/agent-runtime/src/modules/ai/runtime/storage/agent-mastra-store.ts`
- 测试：`apps/agent-runtime/test/agent-mastra-store-fencing.test.ts`

## 核对命令

```bash
psql "$DB_URL" -c '\d run_ownership'
grep -n "supportsRunFencing\\|claimRunOwnership\\|assertFence" \
  apps/agent-runtime/src/modules/ai/runtime/storage/agent-mastra-store.ts
pnpm --filter @app/agent-runtime exec vitest run test/agent-mastra-store-fencing.test.ts
```

## 失效信号

Mastra 升级改了 ownership 接口 / 换存储适配器 / 新增 memory store 也需要 fence（当前只有 workflows 域）。
