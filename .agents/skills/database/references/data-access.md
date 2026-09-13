# 数据访问层：repository（database 引用文件）

> 本文件是 `database` skill 的组成部分，由主 SKILL.md 引用。
> 写 repository / 处理事务、软删、并发写入时必读。代码以
> `apps/server/src/modules/{todo,user,admin,monitor}/*repository.ts` 为参考。

## 1. 分层职责（别越界）

| 层 | 职责 | 不做什么 |
| --- | --- | --- |
| repository | 数据访问：怎么查、怎么写、返回实体 / 模型 | 不抛业务错误、不写业务规则、不 import HTTP 边界（NestJS controller / 守卫） |
| service | 业务规则 + 事务边界（`@Transactional()`）+ 日志 | 不直接拼 SQL |
| controller | 校验入参、转发 | 无业务逻辑 |

- repository 返回 `null` 表示查无；service 判 null 抛 `AppError`（唯一抛错路径）。
- repository 类 `@Injectable()`，在 `<xxx>.module.ts` 的 `providers` 声明；构造器依赖必须显式
  `@Inject`（tsx 不产出 `design:paramtypes`，见 `develop-business-module`），无需手动注册。

## 2. 写操作模式（先查后改）

参考 todo.repository，四种写统一套路：

```ts
// create：repo.create 生成实体 → save 插入
async create(data: DeepPartial<TodoEntity>): Promise<TodoModel> {
  const repo = await this.repo()
  return toTodo(await repo.save(repo.create(data)))
}

// update / remove：先 findOneBy 判空（null 由 service 抛错）→ 再改
async update(id: string, data: DeepPartial<TodoEntity>): Promise<TodoModel | null> {
  const repo = await this.repo()
  const existing = await repo.findOneBy({ id })
  if (!existing) return null
  Object.assign(existing, data)
  return toTodo(await repo.save(existing))
}
```

- 为什么「先查后改」：走实体 `save` 才能触发 `@UpdateDateColumn` 时间戳与 `@BeforeInsert`
  等钩子，并拿到完整行做返回 / 校验；盲目 `update({ id }, data)` 会绕过这些。
- 入参用 `DeepPartial<XxxEntity>`，类型由 DTO 契约保证（字段值已在 service 层校验过）。

## 3. 事务：在 service 层声明

- 跨多行 / 多表写方法在 **service** 加 `@Transactional()`
  （`import { Transactional } from '@repo/kits'`，基于 typeorm-transactional）：
  方法内所有 repository 调用共享同一事务，抛错自动回滚。
- repository 方法**不**自开事务边界；纯读方法不加 `@Transactional()`。
- 参考 todo.service 的 create / update / remove。

## 4. 软删行为（TypeORM DeleteDateColumn）

- `repo.remove(entity)` = 软删：把 `deleted_at` 置时间（UPDATE），行不物理消失。
- `findOneBy` / `find` / queryBuilder **默认排除已软删行**；确需带软删行查用 `.withDeleted()`。
- 软删 + 唯一约束的坑见 model-design.md §4（唯一键必须带 `deletedAt`）。
- 物理删除只用于明确场景（日志清理等），配 `scheduler` / `queue` 定期执行。

## 5. 并发写入：防裸「读-改-写」

- 状态流转 / 扣减 / 计数：两个并发请求同时「查 → 改 → 存」会丢更新。对策二选一：
  - **分布式锁**：`RedisStore.acquireLock` 串行化临界区（现仓库做法，见 `concurrency` skill）；
  - **乐观锁**：实体加 `@Version` 列（仓库当前无先例，引入需迁移加 `version` 列，
    save 时版本不匹配抛错 → service 转冲突业务错误）。
- 唯一约束是最后防线（重复插入被 DB 拒），但不是并发业务的替代品。

## 6. 批量与大数据量

- 小批量写：`repo.save([...])`（数组一次提交）；别在循环里逐条 `save`（每条一次往返）。
- 大批量导入 / 清理：评估分批 + 队列 / 定时（`queue` / `scheduler` skill）异步执行，
  别在请求线程里一口气扛。
- 极大表的列表用 deferred 分页变体（见 query.md §4）。

## 7. 返回映射

- 对外响应走模型裁剪：todo 用 `toTodo` 剥掉 `deletedAt` 等内部字段再返回
  （响应里不泄露软删标记）。
- user / admin repository 内部直接返回实体（auth 流程内部使用）；**出接口前仍应裁剪**
  敏感 / 内部字段（见 `develop-backend-api` 安全性）。

检查项：写操作先查后改；事务在 service 声明、纯读不加；软删语义符合预期（含唯一键）；
并发写有锁或乐观锁；无循环单条写；响应模型不泄露内部字段。
