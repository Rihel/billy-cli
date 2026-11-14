# @repo/db：数据库唯一事实源

> **查证优先级：必核** —— 路径 / 实体清单 / 迁移命令；加实体、改迁移、换 CLI 后重核。

## 结论（2026-11-14）

- `packages/db`（`@repo/db`）持有**全部实体 + 迁移**；导出 `DB_ENTITIES`、`DB_MIGRATIONS` 与具名实体。
- 两个 Nest 应用（main / agent-runtime）的组合根都用 `entities: [...DB_ENTITIES]` 装配，不再手写实体数组；
  `apps/main/src/database/entities/*` 与 `apps/agent-runtime/src/database/entities/*` 只是
  `export { X } from '@repo/db'` 兼容层，**不要在那里加字段**。
- 迁移 CLI 已收归 `@repo/db`（根脚本 `db:*` 指向它）：
  `pnpm --filter @repo/db db:migrate`（脚本先构建 `@repo/db`）；
  `db:gen` 输出到 `packages/db/src/migrations/`。
- gateway 的 `DbModule` 只注册 `AiToolAuditEntity`，用 repository 写 `ai_tool_audit`；不整包注册。

## 关键位置

| 位置 | 内容 |
| --- | --- |
| `packages/db/src/entities/index.ts` | 实体 re-export + `DB_ENTITIES` |
| `packages/db/src/migrations/index.ts` | 迁移 re-export + `DB_MIGRATIONS` |
| `apps/main/src/root.module.ts`、`apps/agent-runtime/src/root.module.ts` | `entities: [...DB_ENTITIES]` |
| `packages/db/data-source.ts` | CLI DataSource 用包导出 |
| `apps/tool-gateway/src/root.module.ts` | 只注册审计实体 |

## 核对命令

```bash
grep -n "DB_ENTITIES" apps/main/src/root.module.ts packages/db/src/entities/index.ts
grep -n "DB_MIGRATIONS" packages/db/data-source.ts packages/db/src/migrations/index.ts
grep -n "AiToolAuditEntity" apps/tool-gateway/src/root.module.ts apps/tool-gateway/src/audit/tool.audit.ts
grep -n "packages/db" apps/agent-runtime/scripts/db-generate.ts apps/agent-runtime/package.json
```

## 失效信号

实体回到 app 内 / 迁移路径变化 / gateway 直接写裸 SQL / 新增 app 各自注册实体；
任一出现都要回来改卡片与 README。
