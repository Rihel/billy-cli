# dependency-upgrade

**查证优先级：抽核**（版本落点会随发布变化；动过 `package.json` / `pnpm-workspace.yaml` 后重核）

## 结论

2026-11-07 全量升级到 registry latest（当天口径）后的落点：Node 26.13.0 + pnpm 12.18.0、
Next 16.4.5、React 19.3.1、NestJS 12.3.3、TypeORM 1.1.2、Tailwind 4.3.5、AI SDK 7.0.164、
Mastra 1.82 / memory 1.41、TanStack Table 9.3.1、Vitest 5.1.0、jsdom 31、Motion 14、katex 0.19.1。
`crypto-js` 换 `@noble/hashes`，`prom-client` 与 `@types/bcryptjs` 删除。

## 升级时踩过的坑（下次升级先看）

1. **ioredis 6 不能升**：TypeORM 1.1.2 的 peer 仍是 `ioredis@^5`，升 6 会让 pnpm 为 `@repo/kits`
   装第二份 typeorm，`FindOperator` 私有成员分属两个声明，server 侧所有 `In()` / `IsNull()`
   报 TS2322。现在锁 5.11.1，等 TypeORM 放开 peer。
2. **jsdom 31 需要 parse5 8.1**：`parse5-parser-stream@8.1.0` 调用 8.1 新增的
   `tokenizer.flushCharacters`，pnpm 解析到 8.0.1 时 jsdom 初始化 TypeError；
   `pnpm-workspace.yaml` 已加 `parse5@>=8.0.0 <9.0.0-0: 8.1.0` override。
3. **TanStack Table 9 是重写**：`useReactTable` / `getCoreRowModel` 没了，改 `useTable` +
   `features: { ...coreFeatures, columnVisibilityFeature }`；`getVisibleCells` 属 column-visibility。
4. **AI SDK 7**：usage 顶层 `reasoningTokens` / `cachedInputTokens` 移到
   `outputTokenDetails.reasoningTokens` / `inputTokenDetails.cacheReadTokens`；
   `tool.description` 可能是函数。
5. **Node 26 镜像没有 corepack**：Dockerfile.base 改为 `npm install -g pnpm@12.18.0`。

## 依据

- `package.json` / `apps/*/package.json` / `packages/*/package.json` 的版本声明
- `pnpm-workspace.yaml` 的 `overrides`（parse5）
- `docs/dev-logs/2026-11-07.md`

## 失效信号

- TypeORM 新版把 ioredis peer 放到 `^6` → 重新尝试 ioredis 6
- jsdom 或 parse5-parser-stream 修复依赖声明 → 可删 parse5 override
- 下一次全量升级：先跑 `pnpm outdated -r` 重核，不直接照抄本卡的版本号
