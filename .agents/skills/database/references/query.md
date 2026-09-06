# 查询：怎么写（database 引用文件）

> 本文件是 `database` skill 的组成部分，由主 SKILL.md 引用。
> 实现读接口 / 列表 / 详情 / 搜索时必读。代码以 `apps/server/src/modules/todo/todo.repository.ts`
> 为参考实现（user / admin / monitor 的 repository 同构）。

## 1. 取 repository

repository 注入 `Db`（DataSource 门面），私有 `repo()` 惰性拿实体仓库：

```ts
constructor(@Inject(Db) private readonly db: Db) {}

private async repo() {
  return this.db.getRepository(XxxEntity)
}
```

## 2. 简单查询：`findOneBy` / `findBy`

- 按主键 / 唯一键取单行：`repo.findOneBy({ id })`、`findByEmail` → `findOneBy({ email })`。
- 返回 `null` 表示查无——**由 service 抛业务错误**（`XxxNotFoundError`），repository 不抛、
  不裸抛 null 出接口（见 `develop-backend-api` 鲁棒性）。
- 默认过滤软删行（见 data-access.md §4）。

## 3. 复杂查询：`createQueryBuilder`

- 动态条件用 `if` 分支 `andWhere`，**避免拼 SQL**，值一律绑定参数：

```ts
const builder = repo.createQueryBuilder('t')
if (keyword) {
  builder.andWhere('t.title ILIKE :keyword', { keyword: `%${keyword}%` })
}
```

- **排序列必须走 DTO 白名单**：`orderBy` 由 schema 限定枚举（如
  `orderBy: z.enum(['updatedAt', 'createdAt'])`）后再拼进模板串——直接拼接前端传入列名
  就是 SQL 注入面（todo / alert-log repository 均为此写法）。
- 关键字搜索：`ILIKE :keyword`（大小写不敏感）；`%kw%` 无法走索引的量级问题见
  [indexing.md](./indexing.md) §5。

## 4. 分页：两种工具（@repo/kits db/pagination.ts）

- **页码分页**（后台管理列表默认）：`pageWith(builder, page, size)` →
  `{ data, total }`，内部做 skip / take + count：
  ```ts
  const { data, total } = await pageWith(builder, page, size)
  return { items: data.map(toXxx), total, page, size }
  ```
- **游标分页**（数据增长快、需要稳定翻页）：`cursorPageWith(builder, options)`，
  排序必须与 `cursorColumns` + `order` 一致，配 `(updatedAt, id)` 索引
  （todo 的 cursor 实现）：
  ```ts
  builder.orderBy('t.updatedAt', 'DESC').addOrderBy('t.id', 'DESC')
  const result = await cursorPageWith<TodoEntity>(builder, {
    cursorColumns: ['updatedAt', 'id'],
    cursorValues: cursor ? [new Date(cursor.updatedAt), cursor.todoId] : undefined,
    getCursor: (row) => ({ updatedAt: row.updatedAt.toISOString(), todoId: row.id }),
    order: 'desc',
    size,
  })
  ```
- **深翻页**：offset 翻页越翻越慢（skip 大）。`@repo/kits` 还提供
  `deferredPageWith` / `deferredCursorPageWith`（先只取主键再回表，当前业务未用，
  极大表启用）。列表别默认给「跳页到第 N 万页」的能力。

## 5. 防 N+1 与关联加载

- 仓库现状是**单表查询**（无关联实体）；若引入关系，遵守：
  - 循环里逐条查库 → 改为收集 id 后一次 `WHERE ... IN (...)` / join 取齐再内存组装；
  - 需要带出关联行用 `leftJoinAndSelect`，但**别在分页查询里 join 一对多集合**
    （行数会翻倍，total 失真）——先分页主表再按 id 批量补关联。
- 只查所需列：`select` 指定列 / 响应经 `toXxx()` 裁剪（同时是性能与安全）。

## 6. 原生 SQL 的边界

- 常规 where / 排序 / 分页都用 queryBuilder，**不手写 SQL 字符串**。
- 只有 queryBuilder 表达不动时才用原生（复杂聚合、窗口函数、递归 CTE）：
  `this.db.query(sql, params)`（DataSource.query，同样绑定参数）。
- 写完仍是参数化语句；raw SQL 属于「能力归位」的例外，需注释说明为什么。

检查项：值全部绑定参数；排序列 schema 白名单；游标与索引配套；无循环内查库；
分页未 join 一对多；响应经映射裁剪。
