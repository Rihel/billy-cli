# @repo/db

数据库**唯一事实源**：所有 TypeORM 实体、迁移、实体清单都在这里，server / capability-gateway / 后续新 app 共用。

## 导出

```ts
import { DB_ENTITIES, DB_MIGRATIONS, ConversationEntity } from '@repo/db'
```

- `DB_ENTITIES`：全量实体类（`DbModule` / 测试 DataSource 直接用）
- `DB_MIGRATIONS`：全量迁移类（TypeORM CLI 用）
- 各实体具名导出

## 约定

- 新增实体放 `src/entities/`，并在 `src/entities/index.ts` 的 `DB_ENTITIES` 注册。
- 新增迁移放 `src/migrations/`，并在 `src/migrations/index.ts` 的 `DB_MIGRATIONS` 注册。
- 迁移由本包的 CLI 统一执行：`pnpm --filter @repo/db db:migrate`（会先构建本包）。
- 实体定义在 `packages/db/src/entities`；迁移在 `packages/db/src/migrations`，不要在其他 app 里重复加字段。
- app 自己的 `DbModule` 只声明它需要的实体（如 gateway 只声明 `AiToolAuditEntity`），
  不要整包注册，避免连接期做无意义的元数据扫描。
