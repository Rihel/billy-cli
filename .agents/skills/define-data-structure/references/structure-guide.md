# 实体与 schema 详解（define-data-structure 引用文件）

> 本文件是 `define-data-structure` skill 的组成部分，由主 SKILL.md 引用。
> 定义数据结构时必读。

## 1. 双轨制（必须同步）

每个业务数据结构有两条「轨道」，必须保持一致：

| 轨道 | 位置 | 职责 |
| --- | --- | --- |
| 实体（数据库表） | `apps/server/src/database/entities/<name>-entity.ts` | TypeORM 表结构、索引、唯一约束 |
| 契约（Zod schema） | `packages/shared/src/schema/<name>.schema.ts` | 请求 / 响应校验与类型（前后端共享） |

动笔前先按「实现查找顺序」确认现成能力：`apps/server/src/database/entities/` 与
`packages/shared/src/schema/` 下同类结构（base / todo / user / admin）就是参考模板，
`@repo/kits` 已提供分页等能力，字段类型与命名直接沿用既有写法，**不要自创风格**。

## 2. 实体规范（TypeORM）

参考：`apps/server/src/database/entities/{user-entity,todo-entity,admin-entity}.ts`
（`BaseEntity` 在 `packages/kits/src/db/base-entity.ts`）。

```ts
import { Column, Entity, Index } from 'typeorm'
import { BaseEntity } from '@repo/kits'

@Entity('todos')                                        // 表名：复数
@Index('idx_update_at_id', ['updatedAt', 'id'])         // 游标排序索引：命名 idx_*（注意是 update_at 非 updated_at）
export class TodoEntity extends BaseEntity {            // 必须继承 BaseEntity
  @Column({ name: 'title', type: 'text' })
  title!: string

  @Column({ name: 'description', type: 'text', nullable: true })
  description: string | null = null

  @Column({ name: 'completed', type: 'boolean', default: false })
  completed = false
}
```

硬性规则：
1. **继承 `BaseEntity`**：自动获得 `id`（nanoid(20) 主键）、`createdAt`、`updatedAt`、
   `deletedAt`（软删除，均为 `timestamp(3)`），`@BeforeInsert` 自动生成 id。
   **不要重复声明这些字段**。
2. **表名复数**：`users` / `todos` / `admins`。
3. **列名 snake_case**（`name: 'real_name'`），字段名 camelCase（`realName`）。
4. **列类型**：仓库现状主要用 `text`（email / password / title / description 等均如此），
   布尔用 `boolean`，时间用 `timestamp` + `precision: 3`；固定长度短值（如 status）才用
   `varchar(length)`。可空列必须 `nullable: true` 并给初始值（`= null` / `= false`）。
5. **索引与唯一约束显式命名**：`@Index('idx_*', [...])`、`@Unique('uk_*', [...])`。
   **软删除 + 唯一约束**必须把 `deletedAt` 纳入唯一键，否则删除后无法重建同名记录：
   ```ts
   @Unique('uk_user_email', ['email', 'deletedAt'])   // user-entity.ts 现有写法
   ```
6. **枚举字段**：用 string 列存字典 value（见 `define-dict-enum` skill），
   `default: UserStatus.Enabled` + `length` + `comment` 中文注释。
7. 实体里**不写业务逻辑**，只做映射与约束。

## 3. 契约规范（Zod schema）

参考：`packages/shared/src/schema/{base,todo,user,admin}.schema.ts`。

### 3.1 模型（响应 / 实体形状）

```ts
import { z } from 'zod'
import { BaseModel } from './base.schema'   // { id, createdAt, updatedAt }，日期可 string|Date

const TodoFields = z.object({
  title: z.string(),
  description: z.string().nullable().optional(),
  completed: z.boolean().default(false),
})

export const TodoSchema = z.intersection(BaseModel, TodoFields)
export type TodoModel = z.infer<typeof TodoSchema>
```

### 3.2 DTO（请求入参）命名约定

| 用途 | Schema | 类型 |
| --- | --- | --- |
| 创建 | `CreateXxxSchema` | `CreateXxxDto` |
| 更新（含 id） | `UpdateXxxSchema` | `UpdateXxxDto` |
| 详情（id 入参） | `GetDetailXxxSchema` | `GetDetailXxxDto` |
| 删除 | `RemoveXxxSchema` | `RemoveXxxDto` |
| 页码分页 | `PageQueryXxxSchema` | `PageQueryXxxDto` |
| 游标分页 | `CursorQueryXxxSchema` | `CursorQueryXxxDto` |

> 详情 DTO 命名以 `GetDetailXxx` 为准（对应现有 `GetDetailTodoSchema` / `GetAdminDetailSchema`）。

```ts
const XxxIdSchema = z.object({ xxxId: z.string() })

export const CreateXxxSchema = XxxFields.omit({ ... })
export const UpdateXxxSchema = z.intersection(XxxIdSchema, XxxFields)   // 或 XxxIdSchema.extend(...)
export const PageQueryXxxSchema = BasePaginateDto.extend({
  keyword: z.string().optional(),
  orderBy: z.enum(['updatedAt', 'createdAt']).optional().default('updatedAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})
```

### 3.3 分页基类（`packages/shared/src/schema/base.schema.ts`）

- `BasePaginateDto`：`{ page（默认 1）, size（默认 10，≤100） }` → 配合 `PageQueryResult`。
- `BaseCursorPaginateDto`：`{ size（默认 20，≤100） }` + 自定义 cursor 模型，如
  ```ts
  export const TodoCursorSchema = z.object({
    updatedAt: z.iso.datetime(),
    todoId: z.string(),
  })
  ```

### 3.4 校验规则要点

- 邮箱 `z.email()`；密码 `z.string().min(6)`；可空字段
  `z.string().nullable().optional()`；日期字段 `z.union([z.string(), z.date()])`。
- 校验错误会经 `parseZodIssues`（`packages/shared/src/utils/zod.utils.ts`）转为中文文案；
  新字段如需友好报错，可在其 `fieldLabels` 表中补中文名。

## 4. 注册与迁移

1. **注入实体**：实体文件放入 `apps/server/src/database/entities/` 后，在
   `apps/server/src/main.ts` 的 `createServiceContext({ db: { entities: [...] } })` 里把
   实体类加入 `entities` 数组（kits 不持有实体，由应用注入）。
2. **注册 schema**：`packages/shared/src/schema/index.ts` 追加
   `export * from './<name>.schema'`。
3. **生成迁移**（依据实体与数据库的差异自动生成，**不手写 SQL**）：
   ```bash
   pnpm db:gen <Name>    # 例如 pnpm db:gen AddProduct
   ```
   生成后**必须人工检查** `apps/server/src/database/migrations/<timestamp>-<name>.ts` 的 SQL
   是否符合预期（列名、类型、索引、唯一约束）。迁移 CLI 使用 `apps/server/data-source.ts`
   （glob 扫 `src/database/entities` 与 `src/database/migrations`）。
4. **执行迁移**：
   ```bash
   pnpm db:migrate
   ```

## 5. 实体 ↔ schema 同步清单

- [ ] 字段名一一对应（实体 camelCase 属性 = schema key），类型一致（string ↔ z.string() 等）
- [ ] 可空 / 默认值一致（实体 `nullable` ↔ schema `.nullable()`；`default` ↔ `.default()`）
- [ ] 实体列名 snake_case 只影响 DB，schema 用 camelCase 属性名即可
- [ ] 变更后重新生成并执行迁移；删除字段先确认无数据依赖
- [ ] 索引覆盖查询路径：游标分页必须有 `(updatedAt, id)` 顺序的索引
