# 能力归位决策（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分。
> 遇到「工程里还没有基础能力」的新需求（状态机、队列、心跳、限流、幂等、异步任务等，
> 而非普通 CRUD）时，先按本文件判断代码该放哪个包 / 目录 / 文件，再动手。

## 1. 决策流程（按顺序问）

拿到一个全新能力，先判断它的「性质」，再落到对应位置：

1. 是**纯函数 / 无状态工具**（无 IO、无生命周期）？ → `packages/shared/src/utils/`
2. 是**跨层共享的契约 / 类型**（DTO、模型）？ → `packages/shared/src/schema/`
3. 是**字典 / 枚举 / 错误码**？ → `packages/shared/src/dicts/`
4. 是**数据库表结构**？ → `apps/server/src/database/entities/`
5. 是**通用数据访问能力**（分页、批量、游标等，不绑定具体业务）？ → `packages/kits/src/db/`
6. 是**外部资源门面**（DB / Redis / MQ / S3 / 消息推送…）？ → `packages/kits/src/infrastructure/`
7. 是**横切基础能力**（配置 / 日志 / ID 生成 / 错误 / 调度器…）？ → `packages/kits/src/foundation/`
8. 是**业务逻辑**（有状态、有 service + repository + errors 三层）？ → `apps/server/src/modules/<业务>/`
9. 是 **HTTP 边界 / 全类型客户端 / 前端页面**？ → `apps/server/src/features/` + `packages/sdk/` + `apps/web|admin/`

## 2. 归位表（能力 → 落点 + 必须遵循的模式）

| 能力性质 | 包 / 目录 / 文件 | 必须遵循的模式 |
| --- | --- | --- |
| 纯函数工具 | `packages/shared/src/utils/<name>.utils.ts` | 纯函数、无 IO、在 `utils/index.ts` 导出 |
| 共享契约 | `packages/shared/src/schema/<name>.schema.ts` | Zod，`z.infer` 出类型，`schema/index.ts` 导出 |
| 字典 / 枚举 / 错误码 | `packages/shared/src/dicts/<name>.dict.ts` | `createDict`，`dicts/index.ts` 导出 |
| 数据库表 | `apps/server/src/database/entities/<name>-entity.ts` | 继承 `BaseEntity`（`@repo/kits`），`main.ts` 注入 `entities` |
| 通用数据访问 | `packages/kits/src/db/<name>.ts`（如 pagination.ts） | 与 `db/` 并列，`kits/index.ts` 导出 |
| 外部资源门面 | `packages/kits/src/infrastructure/<name>.ts` | 见下方「基础设施门面」模式 |
| 横切基础能力 | `packages/kits/src/foundation/<name>.ts` | `@Injectable` + `createServiceContext` 注册 |
| 业务逻辑 | `apps/server/src/modules/<业务>/{errors, <业务>.repository, <业务>.service, index}.ts` | 三层 + 模块 `index.ts` + `main.ts` `addService` 注册 |
| HTTP 边界 | `apps/server/src/features/<业务>.ts` | 路由工厂，`main.ts` 挂载 |
| 全类型客户端 | `packages/sdk/src/server.client.ts` 的一段 | 类型化 `this.post<Model>(...)` |

## 3. 每个落点的模式要求（新增能力必守）

### kits/infrastructure —— 外部资源门面

- `@Injectable()`，构造器注入各自配置分片 bean（如 `RedisConfig` / `DbConfig` / `JwtConfig`，
  来自 `foundation/config/`，zod schema 校验 + 通用默认值；连接串 / 密钥从配置来，禁止硬编码）。
- 实现 `OnAppStart` / `OnAppStop`（连接建立 / 释放），在 `createServiceContext` 用
  `addLifeCycleService` 注册（生命周期顺序由 `@Inject` 声明自动推导）。
- 失败抛 `InfrastructureError` 子类（`foundation/errors/infrastructure-errors.ts`），
  不返回裸结果掩盖错误。
- 保留 `raw` 底层客户端（如 `RedisStore.raw`），供未封装的命令使用。
- 参考：`packages/kits/src/infrastructure/redis-store.ts`（锁 / KV / TTL）、
  `object-storage/`（S3/COS）、`token-signer.ts`、`password-hasher.ts`。

### kits/foundation —— 横切基础能力

- 无外部资源生命周期，`@Injectable()`（来自 `@repo/di`）+ `createServiceContext` `addService` 注册。
- 参考：`app-config.ts`、`logger.ts`、`id-generation.ts`、`scheduler.ts`（定时器/Cron 调度器）、`errors/`。

### server/modules —— 业务逻辑

- 固定三层：`errors.ts`（AppError 子类）+ `<业务>.repository.ts`（数据访问）+
  `<业务>.service.ts`（业务 + `@Transactional` 写操作 + `@Logger`）。
- 两处注册：模块 `index.ts` + `apps/server/src/main.ts` 的 `addService`
  （实体另在 `createServiceContext({ db: { entities } })` 注入）。
- 参考：`apps/server/src/modules/todo/`。

### shared/utils —— 纯工具

- 纯函数、无 IO、不 import 业务包；`utils/index.ts` 导出。
- 参考：`nanoid.utils.ts`、`md5.utils.ts`、`tree.utils.ts`、`dict.utils.ts`。

## 4. 引入新依赖时（状态机 / 队列 / 锁库等）

先按「实现查找顺序」（`code-conventions.md` 第 10 条）：

1. 现有 `RedisStore` 能否实现？（锁 `acquireLock` / 计数 `incr` / TTL `set/expire` /
   列表 / PubSub 经 `raw` 直接调用）能 → **不引库**，封装进 infrastructure。
2. 依赖里已有？（ioredis 的 List / ZSet / PubSub / Stream 都可用）
3. 都没有 → 联网找库（如 BullMQ 队列、xstate 状态机）。

引入新依赖后的归位铁律：

- **门面放 `kits/infrastructure`**（如 BullMQ 的队列封装、S3 的封装），业务模块
  只依赖门面，不散落 `import` 第三方库。
- 纯函数型库（如 xstate 纯状态机）可放 `shared/utils` 或 `kits/foundation`，
  视是否依赖 DI / 配置而定。
- 新依赖必须在对应包 `package.json` 声明，并在 `pnpm-lock.yaml` 落锁。

## 5. 示例：几个「无基础能力」的归位

| 需求 | 归位 | 说明 |
| --- | --- | --- |
| 状态机（订单状态流转） | 轻量：`shared/utils` 字典 + 转移表纯函数；复杂：`kits/foundation` 或独立 `server/modules` | 状态字典放 `dicts/`；转移规则是纯逻辑 |
| 消息队列 / 延迟任务 | 门面 `kits/infrastructure/queue.ts`（ioredis List/ZSet 或 BullMQ） | 生产者 / 消费者都经门面；消费者随生命周期启停 |
| 心跳 / 任务 lease | `kits/infrastructure`（封装 set+ttl 续期 + 锁）或业务 service 内 | 复用 `RedisStore`，不引新库 |
| 高并发：限流 / 幂等 / 缓存 | 封装 `kits/foundation`（incr 计数限流、锁 + setJson 幂等/缓存） | 复用 `RedisStore` |
| 定时任务 / 调度 | `kits/foundation`（Scheduler 门面，croner） | 由 `createServiceContext` 注册 |

> 核心原则：**先归位，再实现**——先明确「这是什么性质的能力、落在哪个包/目录/文件、
> 遵循什么模式」，再写代码。拿不准时读同目录既有文件对照，不要凭空发明位置。
