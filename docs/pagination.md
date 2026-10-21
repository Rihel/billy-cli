# 分页设计指南

> **历史说明**：本文以已移除的 `todo` 模块为案例，保留作为游标分页的设计参考；
> 代码路径与接口是当时的实现，现仓库仅保留通用分页能力（`@repo/kits`）。

本文说明项目中的普通分页（Offset Pagination）与游标分页（Cursor Pagination），以及单表查询和联表查询应如何选择。

当前相关实现位于：

- `apps/server/src/infra/db.service.ts`
- `packages/shared/src/schema/base.schema.ts`
- `packages/shared/src/schema/todo.schema.ts`
- `apps/server/src/modules/todo/todo.service.ts`
- `apps/web/src/app/main/todo/page.tsx`

## 1. 四种分页能力

`DbService` 提供四种分页方法：

| 方法                     | 定位方式        | 查询阶段 | 适用场景                         |
| ------------------------ | --------------- | -------- | -------------------------------- |
| `paginate`               | `page + size`   | 单阶段   | 单表、管理后台页码表格           |
| `paginateDeferred`       | `page + size`   | 两阶段   | 需要总数、跳页的复杂联表表格     |
| `paginateCursor`         | `cursor + size` | 单阶段   | 单表时间流、无限滚动             |
| `paginateCursorDeferred` | `cursor + size` | 两阶段   | 一对多、聚合或重 JOIN 的无限滚动 |

这里的“普通分页”特指基于 `LIMIT/OFFSET` 的页码分页。

## 2. 普通分页

### 2.1 请求与响应

请求一般包含页码和每页数量：

```ts
{
  page: 3,
  size: 20
}
```

响应包含当前页数据和总数：

```ts
{
  items: [...],
  total: 128,
  page: 3,
  size: 20
}
```

前端可以计算：

$$
\text{pageCount} = \left\lceil \frac{\text{total}}{\text{size}} \right\rceil
$$

### 2.2 SQL 原理

第 3 页、每页 20 条通常对应：

```sql
SELECT *
FROM todos
ORDER BY updated_at DESC
LIMIT 20 OFFSET 40;
```

偏移量为：

$$
\text{offset} = (\text{page} - 1) \times \text{size}
$$

`OFFSET 40` 表示数据库先定位或扫描前 40 条，再返回后面的 20 条。

### 2.3 优点

- 支持直接跳到第 N 页。
- 容易展示总页数和页码器。
- 用户可以明确知道当前位于第几页。
- 非常适合后台管理表格。
- API 和缓存模型直观。

### 2.4 缺点

#### 深分页成本增加

页码越深，`OFFSET` 越大。即使有排序索引，数据库通常仍需跳过大量记录：

```sql
LIMIT 20 OFFSET 200000;
```

深分页的响应时间可能随 offset 增长。

#### 数据变化会导致偏移

假设每页 3 条：

```text
page 1: A B C
page 2: D E F
```

用户读取 page 1 后，列表头部新增 X：

```text
page 1: X A B
page 2: C D E
```

此时再请求 page 2，会再次看到 C，或者在其他删除场景下漏掉记录。页码代表的是“当前结果集中的位置”，不是某条稳定记录。

#### 总数查询可能昂贵

为了返回 `total`，普通分页通常还要执行：

```sql
SELECT COUNT(*) FROM ...;
```

复杂过滤和联表下，COUNT 可能成为主要成本。

## 3. Cursor 分页

Cursor 分页不告诉数据库“跳过多少条”，而是告诉数据库“从哪条记录之后继续”。它也称为 Keyset Pagination 或 Seek Pagination。

### 3.1 请求与响应

首次请求没有 cursor：

```ts
{
  size: 20
}
```

后续请求携带上一批返回的 cursor：

```ts
{
  size: 20,
  cursor: {
    updatedAt: '2026-07-26T10:00:00.000Z',
    todoId: 'todo_123'
  }
}
```

响应只需要数据和下一游标：

```ts
{
  items: [...],
  nextCursor: {
    updatedAt: '2026-07-26T09:48:00.000Z',
    todoId: 'todo_087'
  }
}
```

没有下一批时：

```ts
{
  items: [...],
  nextCursor: null
}
```

### 3.2 SQL 原理

Todo 按 `updatedAt DESC, id DESC` 排序，后续查询使用：

```sql
SELECT *
FROM todos
WHERE updated_at < :updatedAt
   OR (updated_at = :updatedAt AND id < :id)
ORDER BY updated_at DESC, id DESC
LIMIT 21;
```

请求 20 条但查询 21 条：

- 最多返回前 20 条。
- 第 21 条只用于判断是否还有下一批。
- 不需要额外 COUNT。

### 3.3 为什么需要两个 cursor 字段

只使用 `updatedAt` 不够稳定，因为多条记录可能拥有相同时间：

```text
A: 10:00:00.000
B: 10:00:00.000
C: 10:00:00.000
```

如果 cursor 只有时间，下一次查询使用 `updated_at < cursor`，与 cursor 同时间但尚未返回的记录会被跳过。

因此需要唯一字段作为最终 tie-breaker：

```text
ORDER BY updated_at DESC, id DESC
```

对应 cursor：

```ts
{
  updatedAt: string
  todoId: string
}
```

数据库排序列仍为 `id`；按照项目 DTO 命名规范，传输字段使用实体语义明确的
`todoId`。

稳定排序必须满足：

1. cursor 字段顺序与 `ORDER BY` 完全一致。
2. 比较方向与排序方向一致。
3. 最后一个字段能够打破并列，通常使用主键。
4. cursor 值能够被无损序列化和还原。

### 3.4 升序和降序

降序列表读取“更小”的下一批：

```sql
WHERE created_at < :createdAt
ORDER BY created_at DESC
```

升序列表读取“更大”的下一批：

```sql
WHERE created_at > :createdAt
ORDER BY created_at ASC
```

项目中的 `createCursorFilter` 会根据 `order` 自动选择 `lt` 或 `gt`。

### 3.5 优点

- 深分页性能通常保持稳定。
- 不需要扫描巨大 OFFSET。
- 头部新增记录不会改变已获取 cursor 的位置。
- 通常不需要 COUNT。
- 很适合无限滚动、消息流、日志流和动态列表。

### 3.6 缺点

- 通常不能直接跳到第 N 页。
- 不天然提供总数和总页数。
- cursor 必须与排序字段严格匹配。
- 多字段 cursor 的协议和索引设计更复杂。
- 排序字段发生修改时，需要明确产品语义。

## 4. Offset 与 Cursor 对比

| 对比项         | Offset 普通分页    | Cursor 分页                  |
| -------------- | ------------------ | ---------------------------- |
| 请求参数       | `page + size`      | `cursor + size`              |
| SQL 定位       | `OFFSET N`         | `WHERE sort_key >/< cursor`  |
| 深分页         | 越深通常越慢       | 通常保持稳定                 |
| 总数           | 通常返回           | 通常不返回                   |
| 跳到第 N 页    | 支持               | 不直接支持                   |
| 头部新增稳定性 | 容易重复或遗漏     | 已有 cursor 通常不受影响     |
| 删除稳定性     | 后续 offset 会移动 | 已有 cursor 通常仍有效       |
| 前端组件       | Pagination/Table   | Infinite Scroll/DataList     |
| 常见用途       | 用户管理、订单后台 | Todo、消息、日志、Feed       |
| 索引要求       | 过滤与排序索引     | 与 cursor 顺序一致的复合索引 |

## 5. 为什么 Todo 使用 Cursor

Todo 页面使用 `DataList` 无限滚动，并允许在列表头部新增任务。

如果使用 offset：

```text
初始：A B C | D E F
新增：X A B | C D E | F
```

前端缓存原本保存：

```text
page 1: A B C
page 2: D E F
```

新增 X 后，如果继续按 offset 请求下一页，缓存需要重新切页，否则可能重复或遗漏。这也是旧实现需要 `rebuildPages` 的原因。

使用 cursor 后，第二批由上一批最后记录的位置决定：

```text
已获取：A B C
cursor：C
```

头部新增 X 不会改变“C 之后”的查询：

```text
本地第一页：X A B C
继续 cursor C：D E F
```

因此前端创建任务只需要：

```ts
firstPage.items.unshift(todo)
```

更新和删除也只需要修改命中的缓存项，不需要重建所有分页。

## 6. 单表 API

### 6.1 `paginate`

适合页码表格：

```ts
const result = await db.paginate({
  table: users,
  where: keyword ? ilike(users.email, `%${keyword}%`) : undefined,
  orderCol: users.createdAt,
  order: 'desc',
  page,
  size,
})
```

返回：

```ts
interface PageResult<T> {
  items: T[]
  total: number
  page: number
  size: number
}
```

### 6.2 `paginateCursor`

适合单表无限滚动：

```ts
const result = await db.paginateCursor({
  table: todos,
  cursorColumns: [todos.updatedAt, todos.id],
  cursorValues: cursor
    ? [new Date(cursor.updatedAt), cursor.todoId]
    : undefined,
  getCursor: (item) => ({
    updatedAt: item.updatedAt.toISOString(),
    todoId: item.id,
  }),
  where: keyword ? ilike(todos.title, `%${keyword}%`) : undefined,
  order: 'desc',
  size,
})
```

`cursorColumns` 与 `cursorValues` 使用 tuple 类型关联：

```ts
cursorColumns: [timestampColumn, varcharColumn]
cursorValues: [Date, string]
```

如果值类型或顺序不匹配，TypeScript 会报错。

## 7. 联表分页与两阶段查询

### 7.1 为什么 JOIN 可能破坏分页

一条主记录可能关联多条子记录：

```text
post A -> comment 1
post A -> comment 2
post A -> comment 3
post B -> comment 4
```

直接执行：

```sql
SELECT ...
FROM posts
LEFT JOIN comments ON comments.post_id = posts.id
ORDER BY posts.created_at DESC
LIMIT 3;
```

LIMIT 3 限制的是联表后的三行，结果可能全部属于 post A，而不是三个 post。分页实体数量和 SQL 行数不再一致。

### 7.2 Deferred Join

两阶段查询先确定主实体，再查询详情：

```mermaid
flowchart LR
  A[主表过滤与排序] --> B[取当页主键和 cursor]
  B --> C[用主键执行 JOIN 或聚合]
  C --> D[按主表主键顺序恢复结果]
```

Stage 1：

```sql
SELECT id, created_at
FROM posts
WHERE ...cursor condition...
ORDER BY created_at DESC, id DESC
LIMIT 21;
```

Stage 2：

```sql
SELECT ...
FROM posts
LEFT JOIN comments ON comments.post_id = posts.id
WHERE posts.id IN (...当页 IDs...);
```

### 7.3 `paginateDeferred`

用于需要页码和 total 的联表表格：

```ts
await db.paginateDeferred({
  table: posts,
  idCol: posts.id,
  orderCol: posts.createdAt,
  page,
  size,
  dataFn: (ids) => loadPostDetails(ids),
})
```

Stage 1 会同时执行 ID 分页和 COUNT。

### 7.4 `paginateCursorDeferred`

用于联表无限滚动：

```ts
await db.paginateCursorDeferred({
  table: posts,
  idCol: posts.id,
  cursorColumns: [posts.createdAt, posts.id],
  cursorValues: cursor
    ? [new Date(cursor.createdAt), cursor.postId]
    : undefined,
  getCursor: ([createdAt, id]) => ({
    createdAt: createdAt.toISOString(),
    postId: id,
  }),
  where,
  order: 'desc',
  size,
  dataFn: (ids) => loadPostDetails(ids),
  getItemId: (item) => item.postId,
})
```

该方法会：

1. 只从主表查询 ID 和 cursor 列。
2. 用 `size + 1` 判断是否存在下一批。
3. 只对当页 ID 执行 `dataFn`。
4. 根据 Stage 1 的 ID 顺序恢复结果。
5. 保留同一主 ID 对应的多条联表结果。

### 7.5 是否总要使用多阶段

不需要。

可以直接 JOIN 的情况：

- 一对一 JOIN。
- JOIN 不会扩展主记录数量。
- 查询只涉及少量窄表。
- 执行计划能够稳定使用过滤和排序索引。

建议使用两阶段的情况：

- 一对多或多对多 JOIN。
- 多个 LEFT JOIN。
- JOIN 后需要聚合。
- 单次详情查询很重。
- LIMIT 应按主实体数量计算。
- 页码分页还需要昂贵 COUNT。

## 8. Deferred Cursor 的约束

### 8.1 Stage 1 的 where

`paginateCursorDeferred.where` 应只引用主表字段。

如果需要按关联表过滤，应改写为 `EXISTS`：

```sql
WHERE EXISTS (
  SELECT 1
  FROM comments
  WHERE comments.post_id = posts.id
    AND comments.content ILIKE '%keyword%'
)
```

不要在 Stage 1 中直接一对多 JOIN，否则仍会产生主记录重复。

### 8.2 关联表字段排序

如果排序字段来自关联表，例如：

```text
按最后一条评论时间排序帖子
```

通用主表 cursor helper 不能直接处理。可选择：

1. 将 `lastCommentAt` 冗余到 posts 主表并维护索引。
2. 使用物化视图或汇总表。
3. 先聚合成唯一主实体结果，再在专用查询上做 cursor。
4. 为该业务编写专用 cursor SQL。

### 8.3 Stage 2 返回顺序

SQL 的 `WHERE id IN (...)` 不保证按 IN 参数顺序返回。

`paginateCursorDeferred` 要求提供：

```ts
getItemId: (item) => item.postId
```

DbService 会按 Stage 1 的 ID 顺序重新排列 Stage 2 结果。

## 9. 索引设计

Cursor 查询应建立与过滤和排序顺序匹配的索引。

Todo 使用：

```sql
ORDER BY updated_at DESC, id DESC
```

对应索引：

```sql
CREATE INDEX todos_updated_at_id_idx
ON todos (updated_at DESC, id DESC);
```

Drizzle 定义：

```ts
index('todos_updated_at_id_idx').on(table.updatedAt.desc(), table.id.desc())
```

注意：

- cursor 列顺序必须与索引前缀顺序一致。
- 常用等值过滤字段通常放在排序字段之前，例如 `(tenant_id, updated_at DESC, id DESC)`。
- 最终 tie-breaker 应唯一且不可为空。
- nullable cursor 列需要明确 `NULLS FIRST/LAST` 语义，项目中优先使用非空 cursor 列。
- 添加索引后应通过 `EXPLAIN ANALYZE` 验证实际执行计划。

## 10. 前端 Infinite Query

Cursor 接口与 TanStack Query 的 `useInfiniteQuery` 直接对应：

```ts
const query = useInfiniteQuery({
  queryKey: ['todo', 'findManyCursor', { size: 20 }],
  initialPageParam: undefined as TodoCursor | undefined,
  queryFn: ({ pageParam }) =>
    trpcClient.todo.findManyCursor.query({
      cursor: pageParam,
      size: 20,
    }),
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
})
```

列表数据：

```ts
const items = query.data?.pages.flatMap((page) => page.items) ?? []
```

滚动到底部：

```tsx
<DataList
  dataSource={items}
  hasMore={query.hasNextPage}
  loadingMore={query.isFetchingNextPage}
  onLoadMore={async () => {
    await query.fetchNextPage()
  }}
/>
```

过滤条件必须进入 query key：

```ts
;['todo', 'findManyCursor', { keyword, size: 20 }]
```

否则不同过滤条件可能共享错误缓存。

## 11. Cursor 列更新问题

如果列表按 `updatedAt` 排序，但更新记录时数据库不修改 `updatedAt`，记录应在原位置更新。

如果更新操作会刷新 `updatedAt`，记录在服务端排序中会移动到顶部。前端应选择：

- 将返回记录移动到第一页顶部；或
- invalidate 并重新获取列表；或
- 使用乐观更新，并在后台校准。

cursor 分页能稳定处理头部新增，但不意味着任意修改排序字段都完全无影响。排序字段应尽可能稳定，或者明确记录移动的产品语义。

## 12. Cursor 的传输与安全

项目当前使用结构化 cursor：

```ts
{
  updatedAt: string
  todoId: string
}
```

它简单、类型清晰，适合内部 tRPC API。

公开 API 可以将 cursor 编码为不透明字符串：

```text
base64url(JSON.stringify(cursor))
```

但编码不是加密，也不能防篡改。如果 cursor 包含敏感数据或需要防篡改，应使用签名，例如 HMAC。

无论采用何种形式，服务端都必须通过 Zod 校验 cursor。

## 13. 一致性边界

普通分页和 cursor 分页默认都不是数据库快照。

用户滚动期间：

- 新记录可能出现在已浏览区域之前。
- 删除记录可能使列表总量减少。
- 更新排序字段可能使记录移动。

Cursor 解决的是“定位稳定性”和“深分页性能”，不是完整快照一致性。

如果业务要求导出时完全一致，应使用：

- 数据库事务快照；
- 固定时间边界，例如 `createdAt <= snapshotAt`；
- 导出任务和临时结果表；
- 版本号或事件序号。

## 14. 选型准则

优先使用普通分页：

- 页面明确展示页码和总数。
- 用户需要跳到指定页。
- 数据量有限。
- 管理后台表格需要可预测导航。
- 查询 COUNT 成本可接受。

优先使用 cursor：

- 无限滚动。
- 数据持续新增。
- 数据量大且会深分页。
- 不需要跳到第 N 页。
- 不需要精确总数。
- 排序键稳定且有合适复合索引。

需要联表时再判断：

```text
JOIN 是否扩行？
├─ 否：可使用单阶段查询
└─ 是：使用 Deferred 两阶段查询
```

项目约定：

```text
DataTable / 后台管理表格 -> paginate / paginateDeferred
DataList / 无限滚动       -> paginateCursor / paginateCursorDeferred
```

## 15. 实施检查清单

### 普通分页

- [ ] `page >= 1`
- [ ] `size` 有最大限制
- [ ] 排序字段有索引
- [ ] 深分页成本可接受
- [ ] COUNT 查询成本可接受
- [ ] JOIN 不会错误放大实体行数

### Cursor 分页

- [ ] cursor 字段与 ORDER BY 顺序一致
- [ ] 最后一个 cursor 字段是唯一 tie-breaker
- [ ] cursor 字段非空，或已定义 NULL 排序规则
- [ ] asc 使用 `>`，desc 使用 `<`
- [ ] 使用 `size + 1` 判断下一批
- [ ] 建立匹配的复合索引
- [ ] 过滤条件进入前端 query key
- [ ] Zod 校验 cursor 输入
- [ ] 明确排序字段更新后的产品行为
- [ ] 一对多 JOIN 使用 Deferred 或专用查询

## 16. 总结

普通分页解决的是“第几页”，Cursor 分页解决的是“从哪里继续”。

- 要页码、总数和跳页：使用普通分页。
- 要稳定滚动和深分页性能：使用 cursor。
- JOIN 不扩行：单阶段通常足够。
- JOIN 扩行或聚合很重：使用两阶段 Deferred。
- Cursor 必须配合稳定排序和复合索引，不能只替换 API 参数而忽略数据库设计。