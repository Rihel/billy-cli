# 从 rihel-base 移植三项能力（DB 批量 / 时间轮 / Kafka 本地设施）

> 触发背景：对比 rihel-base（旧时代 + 中后台场景）后，挑出三项**真正缺失且可直接复用**的能力。
> 前提定位：billy-cli 只做「取」不做「齐」——借鉴具体实现，不追平其框架版本与业务域。

## 1. 难度评估与范围

| 项 | 难度 | 特征 |
| --- | --- | --- |
| DB 批量写入 | 中 | 引入新基础设施能力（分片 + 并发 + 部分失败语义），跨 kits 与调用方 |
| 时间轮 | 中 | 引入新的横切调度能力，与既有 `Scheduler`（croner）职责需划清 |
| Kafka 本地设施 | 简单 | 代码与接线已就绪，只缺可运行的 broker |

## 2. 位置（依据 `placement.md`）

| 能力 | 位置 | 依据 |
| --- | --- | --- |
| 通用数据访问（批量） | `packages/kits/src/db/batch.ts` | §1.5 通用数据访问能力 → `kits/src/db/` |
| 软删（带操作人） | `packages/kits/src/db/safe-delete.ts` | 同上 |
| SQL 调试打印 | `packages/kits/src/db/sql.ts` | 同上 |
| 时间轮 | `packages/kits/src/foundation/time-wheel/` | §1.7 横切基础能力（调度器） |
| Kafka 本地设施 | `docker-compose.yaml`（`profiles: [kafka]`） | billy 单 compose 约定；kafka 可选，不默认启动 |

### 纯函数内核 + `DbService` 注入式统一入口

`Db` 是**连接生命周期统一入口**（`onApplicationBootstrap` 连接 / `onApplicationShutdown` 释放），
而批量写入是**对 `EntityManager` 的操作**，二者生命周期不同：批量方法在事务内必须复用调用方
传入的 `manager`（否则 `@Transactional()` 失效）。

因此按两层落地（对齐 `pagination.ts` 的既有做法 + kits 其它基础设施统一入口的形态）：

1. **纯函数内核**（`batch.ts` / `safe-delete.ts` / `sql.ts`）：显式吃 `manager`，可直接单测，
   脱离 Nest 也能用；
2. **`DbService`**（`db/db.service.ts`，由 `DbModule` 装配、`@Global` 可注入）：薄壳，
   只负责补两个「到处都要传」的参数——**默认 manager**（`Db.dataSource.manager`）与
   **默认操作人**（`getAuditUser()`，与 `AuditSubscriber` 同源）。
   **只依赖 `Db`，不注入 `AppLogger`**（见下）。

> 修订记录：
> ① 初版只落了纯函数，漏掉了上面两个默认值带来的调用方样板 → 补 `DbService`；
> ② 第二版仍把分页排除在外，用户要求与 rihel 对齐 → 分页四种方法一并收进 `DbService`，
> 方法面与 rihel 的 `DBService` 对齐且为其超集（多出游标两种 + `batchDelete` 的 idCol 参数）。

**为什么连分页也收进来**：单看转发价值，分页确实不需要 manager / 操作人；但业务侧只认
`DbService` 一个数据入口，比「分页用纯函数、批量用服务」两套心智更省事。代价是十几行纯样板，
收益是入口唯一——按 rihel 的形态统一。

**命名差异**：rihel 的 `multiplePageWith` 在 billy 叫 `pageWithDeferred`（两阶段：先主键分页再回表）；
billy 另有两个 rihel 没有的游标分页方法。不额外造 rihel 的别名，避免一个能力两个名字。

> ③ 第三版仍给 `DbService` 注入了 `AppLogger`（只为 `printSql`）。用户质疑后核对：kits 里
> 所有注入 AppLogger 的统一入口都有 3~5 处运维日志，唯独 `DbService` 只有 1 处 `debug` 且属于
> **调用方的排障动作**；而 repository / service 按工程约定本就注入了 AppLogger。故去掉该依赖，
> 连 `printSql` 一并去掉（它的方法体只有一次 logger 调用，去掉日志依赖即无内容），
> 只留纯函数的 `getFullSqlStatement`。这是 rihel `DBService` 里唯一没搬的方法。

**不注入 `AppLogger` 的判据**：统一入口是否需要 logger，看它**自己是否产生运维日志**
（连接 / 重试 / 生命周期 / 失败）。`Db`、`KafkaService`、`RedisStore` 等是「是」；
`DbService` 是「否」——它只转发数据操作，把「要不要打这条 SQL」留给持有 SQL 的调用方决定。

**约束保留**：`batch*` / `safeDelete` 在事务方法内必须显式传事务的 `manager`，
否则会落到根 manager 上脱离事务——这条写进类注释与 skill。

### 为什么时间轮不做成 `XxxModule`

- 无自有配置（不需要 `time-wheel.config.ts`）；
- **需要构造参数**（`tickDuration` / `wheelsCount`），且不同场景精度不同 → 天然多实例，
  强做成 `@Global()` 单例是错的抽象；
- 无外部资源连接，不需要 Nest 生命周期托管。

故只导出类，由使用方 `new TimeWheel(tick, count)` 并自行管理 `start()` / `stop()`
（与 `Scheduler` 的区别见下）。能力就绪、按需启用。

### 时间轮 vs 既有 `Scheduler`

| | `Scheduler`（已有） | `TimeWheel`（本次） |
| --- | --- | --- |
| 定位 | 平台级定时任务统一入口 | 进程内高频调度原语 |
| 精度 | 秒级以上（croner） | 毫秒 / 秒级刻度 |
| 规模 | 少量命名任务 | 大量任务（O(1) 槽位插入） |
| 时间基准 | wall clock | `performance.now()` 单调时钟 |
| 漂移 | 由 croner 处理 | 自适应补偿 + 落后任务防堆积 |

二者不冲突：前者管「每天 3 点跑对账」，后者管「限流窗口 / 批量节流 / 心跳轮」。

## 3. 关键数据结构与流程

### 3.1 `db/batch.ts`

```ts
interface BatchOptions { chunkSize?: number; concurrency?: number }  // 默认 100 / 5
```

- `batch(items, handler, options)`：`lodash.chunk` 切片 → `PQueue({ concurrency })` 并发执行
  → 收集失败 → 有失败抛 `BatchOperationError`（聚合，不吞异常）。
- `batchInsert(manager, entityType, data, options)`：每片一条 `INSERT ... VALUES (...)`，
  不触发实体钩子、不级联，适合无关联纯数据写入。
- `batchSave(manager, entityType, data, options)`：`manager.save(chunk)`，触发钩子 + 级联，
  代价是每条一次 SELECT 判断 INSERT/UPDATE。
- `batchUpsert(manager, entityType, data, conflictPaths, options)`：`INSERT ... ON CONFLICT DO UPDATE`。

**规范**：并发度按事务状态自动降到 1——

```ts
const concurrency = manager.queryRunner?.isTransactionActive ? 1 : (options.concurrency ?? 5)
```

事务里开并发连接会导致连接池争用甚至死锁，这是移植时**必须保留**的细节。

### 3.2 `db/safe-delete.ts`

先 `update` 写 `deletedBy` / `updatedBy`（软删审计），再 `softDelete`。操作人由调用方传入
（kits 不依赖 request-context，保持依赖方向）。

### 3.3 `db/sql.ts`

`getFullSqlStatement(builder)`：`getQueryAndParameters()` 后把 `?` 还原为真实值
（`Date` 走 `formatTime`，`null` → `NULL`，字符串加引号），用于慢查询 / 复杂 join 排查。

### 3.4 `foundation/time-wheel/`

移植 rihel 的 `TimeWheel`，三处适配：

1. **cron 分支改用 croner**（kits 既有依赖，避免新增 `cron-parser`）：
   `new Cron(expr, { paused: true }).nextRun(new Date(base))`；
2. `TimeWheelType`（`interval` / `once` / `cron`）与类同文件（是该能力自身的词汇，不是共享数据结构，
   不放进 `shared/dicts`）；
3. 复用 `@repo/shared` 的 `nanoid` / `maybePromise`。

保留 rihel 的两个关键设计：**自适应补偿**（`nextTickTime += tickDuration` 消除执行损耗）
与**落后任务防堆积**（间隔任务目标时间落后过多时按一个刻度补偿）。

## 4. Kafka 现状与本次范围

已核实：`KafkaService` / `@KafkaConsumer` / `KafkaConsumerScanner` / `KafkaModule` **已在 kits**，
`root.module.ts` 已按 `KAFKA_BROKERS` 条件装配，`app-config.ts` 已有 `kafka` 命名空间。
**缺的只是本地 broker** —— 因此本次只补 compose 设施与配置模板，不改代码。

## 5. 测试点

- `batch`：分片数正确、并发受限、单片失败抛 `BatchOperationError` 且携带失败项、
  事务内并发降为 1（`queryRunner.isTransactionActive = true` 的替身）。
- `batchInsert` / `batchSave` / `batchUpsert`：断言 `manager` 被按片调用。
- `getFullSqlStatement`：`?` 还原（含 Date / null / 数字 / 字符串）。
- `TimeWheel`：once 到点触发一次；interval 周期触发且不漂移；removeJob / stop 后不再触发；
  `addJob` 重复 id 抛错、interval < tickDuration 抛错。
