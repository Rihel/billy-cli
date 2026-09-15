# 后端 kits 化改造设计方案（backend-kits-refactor）

> 2026-09-12 更新：组合根已由 `createServiceContext` 改为 NestJS 动态模块 `KitsModule.forRoot`。
>
> 2026-09-12 二次更新：`KitsModule.forRoot` 聚合模块已拆除，改为一个基础设施一个 module、
> 配置即模块自身 bean（`DbModule.forRoot` / `RedisModule.forRoot` / `JwtModule.forRoot` …）。
> 本文正文是该方案的设计记录，保留原貌；**正文中出现的 `KitsModule.forRoot` 均为方案原文，
> 不代表现状**，现状以 `billy-dev-foundation/references/architecture.md` 为准。
>
> 2026-09-12 三次更新：`packages/kits/src` 的目录布局也已调整 —— 原 `foundation/config/` 与
> `infrastructure/` 两个目录拆除，改为「一个基础设施一个目录」（`src/db/`、`src/redis/`、
> `src/rate-limit/`、`src/queue/`、`src/stream/`、`src/jwt/`、`src/session/`、`src/password/`、
> `src/storage/`、`src/kafka/`、`src/lark/`、`src/notification/`、`src/telemetry/`、
> `src/foundation/<能力>/`），配置 bean 并入各自目录（如 `src/redis/redis.config.ts`）。
> **正文中的 `kits/src/infrastructure/...` 与 `foundation/config/...` 路径均为当时布局，不代表现状。**
>
> 2026-09-13 更新：`apps/server` 的组合根已由 `app.module.ts`/`AppModule` 更名为 `root.module.ts`/`RootModule`，
> `CoreModule`（应用级配置 bean）已删除，改为各处经全局 `ConfigService` + `resolveServerConfig()` 取用。

> 2026-09-15 更新：队列方案已整体移除 —— `kits/src/queue/`（BullMQ 的 `QueueManager`）删除，
> 异步消息改用 `kits/src/kafka/`（`KafkaModule` / `KafkaService` / `@KafkaConsumer`）。
> 正文中出现的 `src/queue/`、`QueueManager`、依赖里的 `bullmq` 均为方案原文，不代表现状。

> 2026-09-12 四次更新：配置链路改为 `AppConfigFacade` + `@nestjs/config` + 各模块 `forRootAsync`
> （kits 新增配置模块，应用侧 `apps/server/src/app-config.ts` 组合命名空间配置，
> `main.ts` 先 `await loadServerAppConfig()`）。正文中「配置由 `forRoot(options)` 直接传入」的描述
> 已不代表现状。
>
> 2026-09-12 五次更新：配置模块收拢为单一 `packages/kits/src/foundation/config/`，并把来源抽象为
> **可插拔 `ConfigLoader`**（内置 env / memory / consul，应用可实现接口或用 `registerConfigLoader` 扩展）。
> `AppConfigFacade.initial({ schema, loader })` 的 `schema` 是应用 shape、`loader` 决定来源；
> 旧写法 `loadConfig({ schema, source })` 与 `ConfigSourceError` 已不存在。

> 状态：待评审 · 难度：复杂（架构级改造）· 依据：`billy-dev-foundation/references/design.md`
> 触发背景：第一版目标仿 rihel-base 包划分（基建独立成包、业务归应用层），
> 修正 billy 演化路径中「基建被顺带抽入 core」的偏移，使能力归位。

## 1. 背景与目标

### 1.1 现状问题

- `packages/core` 是「业务核心（modules）+ 基建门面（infrastructure）+ 横切能力（foundation）+ 组合根（runtime.ts）」的混合体，与它「把核心业务逻辑抽取为包」的原始定位不符；
- `packages/db` 同时含**通用能力**（createDb / pagination / BaseEntity）与**业务资产**（User/Todo/Admin 实体 + 迁移），模板包不应持有具体业务 schema；
- 任何需要基建的非业务消费者（worker / cron / 未来服务）必须依赖 core 全量，背上业务模块与全量依赖；
- 组合根 `createAppContext` 位于 core，但组合根本质属于应用层。

### 1.2 目标架构（对齐 rihel-base：service-shared 独立、业务归 server）

```
packages/kits        后端通用能力封装（无任何业务实体，纯能力集）
                     —— 数据库 / 缓存(Redis) / JWT / hash / 队列 / 广播(PubSub) / 存储 / 调度等
  infrastructure/    Db(createDb) / RedisStore / QueueManager / ObjectStorage /
                     TokenSigner / SessionStore / PasswordHasher
  foundation/        AppConfig / Logger / IdGeneration / Scheduler / errors
  db/                createDb / pagination(pageWith/cursorPageWith) / BaseEntity /
                     typeorm-transactional re-export
  入口               KitsModule.forRoot({ db: { entities, url, sync }, ... })
DI 容器            @nestjs/common 原生容器（原 @repo/di InversifyJS 门面已删除）
packages/shared      不动（跨端契约 / DICT / 工具）
packages/sdk         不动（前端全类型客户端）
apps/server          database/(实体 + data-source + migrations)
                     modules/(业务：auth/user/todo/admin，module/controller/service/repository 同目录)
                     common/(横切 HTTP 构件) + main(NestFactory 启动) + scripts/(seed-admin)
scripts/cli          不动（脚手架生成器，已确认不依赖 core/db）
```

- `packages/core`、`packages/db` 两个包**删除**；
- 业务模块物理移入 `apps/server`，但**业务逻辑与 HTTP 边界分离**（分层铁律不破：controller 只做校验与转发，业务逻辑在 service / repository）。

## 2. 落点映射（文件级）

### 2.1 新建 `packages/kits`（来源：core + db 的通用部分）

| 来源 | 迁入 kits |
| --- | --- |
| `core/src/infrastructure/` 全部 | `kits/src/infrastructure/`（Db / RedisStore / QueueManager / ObjectStorage / TokenSigner / SessionStore / PasswordHasher）——当时布局，现已按「一个基础设施一个目录」拆到 `kits/src/<name>/` |
| `core/src/foundation/` 全部 | `kits/src/foundation/`（AppConfig / Logger / IdGeneration / Scheduler / errors） |
| `db/src/db.ts` | `kits/src/db/db.ts` —— **改 API：`createDb({ entities, ...options })`，实体参数注入** |
| `db/src/pagination.ts` | `kits/src/db/pagination.ts`（原样） |
| `db/src/entities/base-entity.ts` | `kits/src/db/base-entity.ts`（通用审计字段基类，属能力） |
| `db` 的 typeorm-transactional 导出 | kits `index.ts` 继续 re-export |

依赖：`@nestjs/common`、`@repo/shared`、`typeorm`、`typeorm-transactional`、`pg`、`ioredis`、`bullmq`、`croner`、S3/COS SDK 等（即现 core + db 的依赖合集，去掉业务相关项）。

### 2.2 `apps/server` 新增（来源：core + db 的业务部分）

| 迁入 server | 说明 |
| --- | --- |
| `core/src/modules/{auth,user,todo,admin}/` | `server/src/modules/`，三层结构原样（errors/repository/service/index） |
| `db/src/entities/{user,todo,admin}-entity.ts` | `server/src/database/entities/` |
| `db/data-source.ts` | `server/data-source.ts`（glob 路径改指 server 目录） |
| `db/migrations/*` | `server/src/database/migrations/` |
| `db` 的 `db:generate` / `db:migrate` 脚本 | `server/package.json` scripts（typeorm CLI + tsx 方式不变） |
| `scripts/seed-admin.ts` | `server/scripts/seed-admin.ts`（根命令改指 server） |

### 2.3 就地修改

- `core/src/runtime.ts` 拆分：
  - `kits` 提供 `KitsModule.forRoot({ db: { entities, ... } })` —— 装配 AppConfig + 全部基建 + 基础能力；
  - `server/src/main.ts` 在其上装配 `app.module.ts`（业务模块 + 全局过滤器 / 拦截器），形成应用组合根；
- `apps/server` 原 features/lib：改为 `common/`（横切 HTTP 构件）与 `modules/<业务>/`（含 controller），import 改内部相对路径或 `from '@repo/kits'`；
- 根 `package.json`：移除 `@repo/core`/`@repo/db` 依赖；`db:gen`/`db:migrate`/`seed:admin` 改指 server；
- `apps/web` landing 文案（`features.tsx` / `architecture.tsx` 中 `@repo/core` 展示项）同步改；
- `pnpm-workspace.yaml` / `turbo.json` 无需变（apps/* 与 packages/* 均在 workspace）。

## 3. 关键设计决策

1. **实体注入**：`createDb({ entities, ... })`、`KitsModule.forRoot({ db: { entities, ... } })`——kits 不持有任何实体，app 注入自己的实体列表（kits 的唯一 API 形状变化点）；
2. **组合根归属**：基建装配（`KitsModule.forRoot`）在 kits；业务模块注册在 server `app.module.ts` 的 imports。scripts/worker/cron 用 `KitsModule.forRoot`，不依赖 server；
3. **BaseEntity 归 kits**：通用审计字段（id=nanoid(20) / createdAt / updatedAt / deletedAt）是能力，业务实体继承之；
4. **迁移自管**：迁移工具链（data-source + migrations + CLI 脚本）整体下沉 app 层，每 app 用自己的实体列表生成/执行迁移；
5. **命名**：`@repo/kits`（用户定名，语义=后端通用能力工具集）；与 rihel-base 前端 `client-kits` 无命名冲突（billy 前端包为 ui/http-client/api-client）；
6. **发布**：第一版 `private: true` 不发布；若未来跨项目复用，再开 `publishConfig` 并验证 tsdown 构建产物（与 rihel-base tsup 不同，需单独验证）；
7. **共享实体演进路径（微服务共享库场景）**：kits 定位为纯能力封装（数据库 / 缓存 / JWT / hash / 队列 / 广播等），**永不持有实体**。若出现「多个 app 共享同一数据库 schema」的需求，由上层**自行沉淀独立共享包**（如 `@repo/entities`：TypeORM 实体 + 迁移，单一来源 + 单一迁移所有者）供各 app 复用；kits 的 `createDb({ entities })` 注入接口天然兼容（app 可传共享包实体）。**本次改造不建该包**，触发条件：出现第二个共享同一库的服务。

## 4. 迁移顺序（小步快走，每阶段可独立验证）

| 阶段 | 内容 | 验证点 |
| --- | --- | --- |
| 0 | 本设计文档评审通过 | —— |
| 1 | 新建 `packages/kits`：迁入 infrastructure + foundation + db 通用能力（createDb 改实体注入）；kits 自身测试跑通 | `pnpm --filter kits run test` |
| 2 | `packages/core` 依赖 kits 并 re-export（**apps/server、scripts 零改动**） | `pnpm dev:pkgs`、server 启动回归 |
| 3 | server 建 `database/`：实体 + data-source + migrations 迁入，挂迁移脚本 | `db:generate` 生成 + `db:migrate` 执行成功 |
| 4 | 业务 modules 迁入 server；原 features/lib 改 `common/` + `modules/`（含 controller）；main 改用 KitsModule.forRoot + 业务模块注册 | 全部接口回归（auth/todo/user/admin/storage） |
| 5 | seed-admin 迁入 server；scripts/cli 确认无 core/db 依赖 | `seed:admin` 执行成功 |
| 6 | 删除 `packages/core`、`packages/db`；改根 package.json 脚本与依赖；改 apps/web 文案 | `pnpm build` 全量通过 |
| 7 | 同步文档与 skill（见 §5）；README 架构章节更新 | 文档检索无残留旧路径 |
| 8 | 全量验证：dev:pkgs + 三 app 类型检查 + dev:server + docker 构建 | 见 §7 |

## 5. 影响面清单（同步对象）

**skill（按 manage-skills 代码变更后同步要求）**：

| skill / 文件 | 改动 |
| --- | --- |
| `billy-dev-foundation/SKILL.md` | 完成检查清单：实体注册 / runtime 注册项改为 kits + server 路径 |
| `billy-dev-foundation/references/architecture.md` | 分层图重画（kits/server 替代 core/db） |
| `billy-dev-foundation/references/placement.md` | 归位表：基建 → kits，业务 → server，实体 → server/database |
| `billy-dev-foundation/references/commands.md` | `db:gen` 指向 server |
| `billy-dev-foundation/references/code-conventions.md` | core/db 引用路径更新 |
| `billy-dev-foundation/references/workflow.md` | 全链路路径更新 |
| `define-data-structure/*` | 实体路径 + createDb 注册 + 迁移路径（大改） |
| `develop-business-module/*` | 模块落点 + 三处注册改两处（kits 装配 + server 注册）（大改） |
| `implement-auth/references/auth-guide.md` | token-signer/session-store 路径 |
| `write-tests/references/testing-guide.md` | `@repo/core` 引用 |
| `define-dict-enum/references/dict-guide.md` | core modules 路径 |
| `object-storage/references/storage-guide.md` | ObjectStorage 路径 |

**文档**：`README.md`（架构 / 目录 / 命令章节）、`docs/pagination.md`、`docs/queue.md`（若引用 db/core 路径）。

## 6. 风险与边界条件

1. **typeorm-transactional 初始化顺序**：`initializeTransactionalContext()` 必须先于 `addTransactionalDataSource`——现有 createDb 已处理，保持不破坏；
2. **data-source glob 路径**：迁入 server 后必须改指 server 目录，否则 CLI 扫不到实体/迁移；
3. **`@Transactional` re-export**：现从 `@repo/db` 导出（core 依赖链），kits 必须继续 re-export typeorm-transactional，否则业务模块 `@Transactional()` 断链；
4. **docker 构建**：`Dockerfile.server` 走 `tsc -p tsconfig.build.json`，server 的 tsconfig/依赖更新后需验证镜像构建；
5. **迁移历史连续性**：`db/migrations/` 已执行的迁移文件原样迁入 server（不重命名时间戳），避免已应用迁移与文件不一致；
6. **根脚本**：`seed:admin`、`db:gen`、`db:migrate` 从根包直调改为 `pnpm --filter @app/server`，命令文档同步。

## 7. 测试点

- kits：createDb 工厂（实体注入 + 事务装配）、pagination 单测（现有测试迁移）;
- server：业务模块单元测试（从 core 迁移，结构不变）;
- 集成：迁移 generate → 人工检查 SQL → migrate 执行；dev:server 启动 + 全接口回归; seed-admin 幂等执行;
- 回归：`pnpm dev:pkgs`、三 app 类型检查、`pnpm build`、docker 构建。

## 8. 回滚

分阶段推进，每阶段独立验证：阶段 2 之后 core 仍为 re-export 壳，任意阶段失败可回退（kits 新增不删旧包；实体/迁移在 server 与 db 双份期间以 db 为准，server 版验证通过后再删源）。删除 core/db 是最后动作（阶段 6），此前一切可逆。

## 9. 已确认项（评审结论）

- [x] 包名：`@repo/kits`（后端通用能力封装：数据库 / 缓存 / JWT / hash / 队列 / 广播 / 存储 / 调度，无实体）
- [x] `packages/db` 全并 kits（能力部分），实体与迁移归 `apps/server`（单服务场景）
- [x] 共享实体（微服务共享库）由上层自行沉淀独立包，kits 不持有（见 §3-7 演进路径）
- [x] 实体迁移历史原样迁入 server，不重命名时间戳
- [x] `docs/pagination.md`、`docs/queue.md` 中 db/core 引用一并修订
