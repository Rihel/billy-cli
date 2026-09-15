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
6. 是**外部资源门面**（DB / Redis / MQ / S3 / 消息推送…）？ → `packages/kits/src/<基础设施>/`
   （如 `redis/` / `rate-limit/` / `stream/` / `storage/` / `kafka/` / `lark/` / `notification/`）
7. 是**横切基础能力**（多源配置 / 日志 / ID 生成 / 错误 / 调度器…）？ → `packages/kits/src/foundation/<能力>/`
8. 是**业务逻辑**（有状态、有 service + repository + errors 三层）？ → `apps/server/src/modules/<业务>/`
9. 是 **HTTP 边界 / 全类型客户端 / 前端页面**？ → `apps/server/src/modules/<业务>/<业务>.controller.ts` + `packages/sdk/` + `apps/web|admin/`

## 2. 归位表（能力 → 落点 + 必须遵循的模式）

| 能力性质 | 包 / 目录 / 文件 | 必须遵循的模式 |
| --- | --- | --- |
| 纯函数工具 | `packages/shared/src/utils/<name>.utils.ts` | 纯函数、无 IO、在 `utils/index.ts` 导出 |
| 共享契约 | `packages/shared/src/schema/<name>.schema.ts` | Zod，`z.infer` 出类型，`schema/index.ts` 导出 |
| 字典 / 枚举 / 错误码 | `packages/shared/src/dicts/<name>.dict.ts` | `createDict`，`dicts/index.ts` 导出 |
| 数据库表 | `apps/server/src/database/entities/<name>-entity.ts` | 继承 `BaseEntity`（`@repo/kits`），在 `root.module.ts` 的 `DbModule.forRootAsync` 工厂里补进 `entities` |
| 通用数据访问 | `packages/kits/src/db/<name>.ts`（如 pagination.ts） | 与 `db/` 同目录，`db/index.ts` 导出 |
| 外部资源门面 | `packages/kits/src/<name>/`（provider + `<name>.config.ts` + `<name>.module.ts` + `index.ts`） | 见下方「基础设施模块」模式 |
| 横切基础能力 | `packages/kits/src/foundation/<name>/`（同上四件套） | `@Injectable()` + 放进对应 `<name>.module.ts` 的 `providers` / `exports` |
| 业务逻辑 | `apps/server/src/modules/<业务>/{errors, <业务>.repository, <业务>.service, <业务>.module, index}.ts` | 三层 + module `providers` 声明，再把模块加入 `root.module.ts` 的 `imports`；实体在 `DbModule.forRootAsync` 工厂里注入 |
| HTTP 边界 | `apps/server/src/modules/<业务>/<业务>.controller.ts` | `@Controller` + `@Post` + `@HttpCode(200)` + `@Body({ schema: Schema })`，加入本模块 `controllers` |
| 横切 HTTP 构件 | `apps/server/src/common/{error,request-context,request-logger,request-metrics,security,http}/<name>.ts`（外部从 `common/index.ts` 导入） | 不依赖具体业务模块（跨模块协作走 token 由 `root.module.ts` 注入） |

## 3. 每个落点的模式要求（新增能力必守）

### kits/<基础设施>/ —— 一个基础设施一个目录

新增基础设施 = 在 `packages/kits/src/<name>/` 下同时放四样东西：

| 文件 | 作用 |
| --- | --- |
| 门面实现（如 `<name>.ts`） | `@Injectable()`，构造器注入自己的配置 bean；**每个构造器参数显式 `@Inject(token)`**（tsx 不产出 `design:paramtypes`） |
| `<name>.config.ts` | 配置 schema + 类型 + Symbol token（如需配置），由 `forRoot` 内 `Schema.parse(options)` 校验 + 补默认值 |
| `<name>.module.ts` | `@Global()` + `static forRoot(options)`（同步：`Schema.parse(options)`）与 `static forRootAsync(options: InfraModuleAsyncOptions<...>)`（异步：`useFactory` 惰性返回分片，模块内仍 `Schema.parse`）；提供「配置 bean + 门面实例」并 `exports` |
| `index.ts` | 聚合导出，供 `packages/kits/src/index.ts` 转出 |

- 把该模块加入 `apps/server/src/root.module.ts` 的 `imports` 即完成装配；**不 import 即视为未启用**。
- **需要配置的模块应用 `forRootAsync` + `ConfigService` 惰性取**（见 `SKILL.md` 第 7 条铁律）：
  `forRootAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (config) => config.get('<命名空间>') })`；
  同步 `forRoot(options)` 仅用于配置不在应用配置里的场景（如 CLI 生成的独立服务）。
- 应用侧配置定义在 `apps/server/src/app-config.ts`：`serverAppConfigSchema` **复用 kits 各模块的
  `*.config.ts` schema** 组成命名空间，`mapServerEnv` 负责环境变量映射；新增需要配置的基础设施时，
  在这里加一个命名空间 + `ConfigService.get('<命名空间>')` 即可。
- 无自有配置、复用上游配置 bean 的模块写成纯模块（如 `RateLimitModule` /
  `StreamHubModule` / `SessionModule`）。
- 连接串 / 密钥从配置来，禁止硬编码；实现 `OnApplicationBootstrap` / `OnApplicationShutdown`
  管理连接建立 / 释放，生命周期由 Nest 在 `app.close()` 时逆序释放。
- 失败抛 `InfrastructureError` 子类（`foundation/errors/infrastructure-errors.ts`），
  不返回裸结果掩盖错误。
- 保留 `raw` 底层客户端（如 `RedisStore.raw`），供未封装的命令使用。
- 参考：`packages/kits/src/redis/`（`redis-store.ts` 锁 / KV / TTL、`redis-lock.service.ts`、
  `redis.config.ts`、`redis.module.ts`）、`packages/kits/src/storage/`（`object-storage.ts` +
  `providers/{s3,cos}.ts`）、`packages/kits/src/jwt/`（`token-signer.ts` + `jwt.config.ts` +
  `jwt.module.ts`）、`packages/kits/src/password/`。

### kits/foundation —— 横切基础能力

- 同样「一个能力一个目录」：`foundation/<name>/{<name>.ts, <name>.config.ts（如需）, <name>.module.ts, index.ts}`。
- 无外部资源生命周期，`@Injectable()`（来自 `@nestjs/common`）+ 放进对应 `<name>.module.ts` 的
  `providers` / `exports`（无配置依赖的写成纯模块，如 `SchedulerModule` / `IdGenerationModule`）。
- 参考：`foundation/logger/`（`app-logger.ts` + `logger.config.ts` + `logger.options.ts` +
  `LoggerModule`）、`foundation/id-generation/`、`foundation/scheduler/`（定时器 / Cron 调度器）、
  `foundation/errors/`、`foundation/config/`（可插拔 `ConfigLoader` + `AppConfigFacade`，新增来源实现 loader 接口即可）。
- 需要日志时**构造器注入** `@Inject(AppLogger)`（不要用已删除的 `@Logger()` 装饰器）；
  新增日志后端 / 输出目标时改 `logger.options.ts` 的 `buildLoggerParams`，不要在业务里直连 pino。

### server/modules —— 业务逻辑

- 固定三层：`errors.ts`（AppError 子类）+ `<业务>.repository.ts`（数据访问）+
  `<业务>.service.ts`（业务 + `@Transactional` 写操作；日志用构造器注入 `AppLogger`）；同目录再放
  `<业务>.controller.ts`（HTTP 边界）与 `<业务>.module.ts`。
- 注册：模块 `index.ts` 聚合导出 + `<业务>.module.ts` 的 `controllers` / `providers` 声明，
  再把该模块加入 `apps/server/src/root.module.ts` 的 `imports`（无副作用导入与自动注册）。
  实现 `OnApplicationBootstrap` / `OnApplicationShutdown` 钩子的类由 Nest 按生命周期调度。
  （实体另在 `root.module.ts` 的 `DbModule.forRootAsync` 工厂里注入。）
- 参考：`apps/server/src/modules/todo/`。

### shared/utils —— 纯工具

- 纯函数、无 IO、不 import 业务包；`utils/index.ts` 导出。
- 参考：`nanoid.utils.ts`、`md5.utils.ts`、`tree.utils.ts`、`dict.utils.ts`。

## 4. 引入新依赖时（状态机 / 队列 / 锁库等）

先按「实现查找顺序」（`code-conventions.md` 第 10 条）：

1. 现有 `RedisStore` 能否实现？（锁 `acquireLock` / 计数 `incr` / TTL `set/expire` /
   列表 / PubSub 经 `raw` 直接调用）能 → **不引库**，封装进 `kits/src/<基础设施>/`。
2. 依赖里已有？（ioredis 的 List / ZSet / PubSub / Stream 都可用）
3. 都没有 → 联网找库（如 Kafka 客户端 `kafkajs`、xstate 状态机）。

引入新依赖后的归位铁律：

- **门面独立成 `kits/src/<基础设施>/` 目录**（如 Kafka 的封装 → `kits/src/kafka/`、
  S3 的封装 → `kits/src/storage/`），业务模块只依赖门面，不散落 `import` 第三方库。
- 纯函数型库（如 xstate 纯状态机）可放 `shared/utils` 或 `kits/src/foundation/<能力>/`，
  视是否依赖 DI / 配置而定。
- 新依赖必须在对应包 `package.json` 声明，并在 `pnpm-lock.yaml` 落锁。

## 5. 示例：几个「无基础能力」的归位

| 需求 | 归位 | 说明 |
| --- | --- | --- |
| 状态机（订单状态流转） | 轻量：`shared/utils` 字典 + 转移表纯函数；复杂：`kits/foundation` 或独立 `server/modules` | 状态字典放 `dicts/`；转移规则是纯逻辑 |
| 异步消息 / 事件驱动 | 门面 `kits/src/kafka/`（`KafkaService` 生产者 + `@KafkaConsumer` 注解消费者）+ `KafkaModule` | 生产者 / 消费者都经门面，不散落 `import kafkajs`；**延迟 / 周期任务交 `foundation/scheduler`**，别指望 MQ |
| 心跳 / 任务 lease | `kits/src/redis/`（封装 set+ttl 续期 + 锁）或业务 service 内 | 复用 `RedisStore`，不引新库 |
| 高并发：限流 / 幂等 / 缓存 | 限流用 `kits/src/rate-limit/`；幂等 / 缓存复用 `RedisStore` | 复用 `RedisStore` |
| 定时任务 / 调度 | `kits/src/foundation/scheduler/`（Scheduler 门面，croner） | 由 `SchedulerModule` 装配（无配置依赖的纯模块） |

> 核心原则：**先归位，再实现**——先明确「这是什么性质的能力、落在哪个包/目录/文件、
> 遵循什么模式」，再写代码。拿不准时读同目录既有文件对照，不要凭空发明位置。
