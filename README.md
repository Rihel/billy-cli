# Billy

> 一套基于 Hono、InversifyJS 与 Next.js 16 的全栈应用 Monorepo 模板。
> 后端采用「Hono 薄边界 + 业务模块（apps/server）+ 通用能力封装 @repo/kits（DI 封装于 @repo/di）」，
> 前端提供两套独立入口：Web（Base UI + shadcn/ui）与 Admin（Ant Design 6）。

## 技术栈

```
apps/
├── server   — Hono 4 HTTP 边界 + 业务模块 + 组合根（端口 9989）
├── web      — Next.js 16 App Router + Base UI + shadcn/ui + Tailwind 4（端口 9840）
└── admin    — Next.js 16 App Router + Ant Design 6 + @repo/aui + Zustand（端口 9845）
packages/
├── shared   — Zod schemas + 错误码字典 + 响应工具 + Pino 日志 + 通用工具（前后端共享）
├── kits     — 后端通用能力封装：Db / Redis / JWT / ObjectStorage / 队列 / 调度 / 分页 + createServiceContext（无业务实体）
├── di       — DI 门面：@Injectable/@Inject + AppContext 组合根 + 生命周期调度（InversifyJS 8 封装）
├── api-client — 通用 HTTP + 鉴权管线客户端（ApiClient / 策略 / 凭证管理器，业务无关）
├── sdk      — ServerClient（全类型化业务 API 调用，构建在 @repo/api-client 之上）
├── ui       — Base UI + shadcn 风格共享组件库（Tailwind 4）
└── aui      — Ant Design 管理端组件库（表格 / 表单 / 存储 / Server Action 工具）
```

| 层         | 选型                       | 理由                                        |
| ---------- | -------------------------- | ------------------------------------------- |
| 构建系统   | pnpm + Turbo               | monorepo 依赖管理 + 按拓扑任务编排 |
| 服务端框架 | Hono 4                     | 轻量 HTTP 边界，业务模块归 apps/server，通用能力归 @repo/kits |
| 依赖注入   | @repo/di（InversifyJS 8）   | `@Injectable` class + `AppContext` 组合根    |
| API 层     | POST JSON（Hono Routes）   | Zod 边界校验 + 全类型化 SDK                 |
| ORM        | TypeORM                    | 装饰器实体 + Repository + QueryBuilder      |
| 前端框架   | Next.js 16 App Router      | RSC + SSR + Server Actions                  |
| 后台 UI    | Ant Design 6 + @repo/aui   | ProTable 风格表格 / ModalForm 开箱即用      |
| 前台 UI    | Base UI + shadcn/ui        | 无样式原语 + 可定制组件，Tailwind 4 驱动    |
| 状态管理   | Zustand + Immer（admin）   | 轻量、不可变、无 boilerplate                |
| 服务端状态 | TanStack Query             | 查询缓存 / 失效 / 重试                      |
| 样式       | Tailwind 4                 | 原子化 CSS，零心智负担                      |
| 日志       | Pino                       | 结构化日志，开发 pretty / 生产 JSON         |
| 缓存       | Redis（ioredis）           | Set / List / Hash / PubSub / 分布式锁       |
| 对象存储   | S3 / COS                   | 预签名 URL + 临时凭证（STS）                |
| 构建工具   | tsdown                     | 快速 bundler，packages 全部 dts 构建        |
| 容器化     | Docker multi-stage         | server + web 独立部署，compose 一键起依赖   |

## 快速开始

### 前置条件

- Node.js >= 20（推荐 24，Docker 基础镜像使用 24.14.1）
- pnpm >= 11（`corepack enable && corepack prepare pnpm@11.15.0 --activate`）
- PostgreSQL（可用 `docker compose up postgres` 一键启动）
- Redis（默认连接 `localhost:6379`，服务启动（`runtime.start()`）时会建立连接，未启动会导致服务启动失败）
- MinIO / S3 / COS（可选，仅存储模块需要；未配置对象存储相关环境变量时使用默认值）

### 安装

```bash
pnpm install
```

### 环境变量

创建 `apps/server/.env`：

```env
PORT=9989
DB_URL=postgresql://user:password@localhost:5432/billy-cli
REDIS_URL=redis://localhost:6379/0
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=7d

# 可选：认证行为
RESET_PASSWORD_TOKEN_TTL_MINUTES=30
PASSWORD_HASH_ROUNDS=10

# 可选：对象存储（s3 / cos）
OBJECT_STORAGE_PROVIDER=s3
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_BUCKET=billy-cli
OBJECT_STORAGE_ACCESS_KEY_ID=minioadmin
OBJECT_STORAGE_SECRET_ACCESS_KEY=minioadmin
OBJECT_STORAGE_ENDPOINT=http://localhost:9000

# 可选：日志
LOGGER_NAME=app
LOGGER_PRETTY=true
```

创建 `apps/web/.env.local`：

```env
NEXT_PUBLIC_SERVER_URL=http://localhost:9989
```

创建 `apps/admin/.env.local`：

```env
SERVER_URL=http://localhost:9989
NEXT_PUBLIC_STORAGE_URL=http://localhost:9000/billy-cli
```

### 数据库

```bash
# 生成迁移文件（写入 apps/server/src/database/migrations/）
pnpm db:gen Initial

# 执行迁移
pnpm db:migrate
```

### 启动（开发）

```bash
# 终端 1：并行 watch 构建 packages（shared / kits / di / ui / sdk / aui）
pnpm dev:pkgs

# 终端 2：启动 Hono 服务（http://localhost:9989）
pnpm dev:server

# 终端 3：启动 Web 前台（http://localhost:9840）
pnpm dev:web

# 终端 4（可选）：启动 Admin 后台（http://localhost:9845）
pnpm dev:admin
```

### 构建与启动（生产）

```bash
# 全量构建（turbo，按依赖拓扑）
pnpm build

# 分别启动
pnpm start:server
pnpm start:web

# 或 Docker Compose（postgres + redis + minio + server + web）
pnpm docker:up
```

## 项目结构

```
├── apps/
│   ├── server/                          # Hono HTTP 边界（@app/server）
│   │   ├── data-source.ts               # TypeORM CLI 迁移配置（db:generate / db:migrate）
│   │   ├── scripts/seed-admin.ts        # 首个管理员种子脚本
│   │   └── src/
│   │       ├── main.ts                  # 入口 + 应用组合根（createServiceContext + addService）+ 优雅关闭
│   │       ├── database/
│   │       │   ├── entities/            # 业务实体：UserEntity / TodoEntity / AdminEntity
│   │       │   └── migrations/          # TypeORM 迁移产物
│   │       ├── modules/                 # 业务模块：auth / admin / user / todo（service + repository + errors）
│   │       ├── lib/
│   │       │   ├── http.ts              # jsonBody / success / errorHandler / 错误码→HTTP 映射
│   │       │   ├── authentication.ts    # requireAuth 中间件（Bearer / cookie）
│   │       │   ├── request-context.ts   # AsyncLocalStorage 请求上下文
│   │       │   └── request-logger.ts    # 请求日志 + X-Request-Id
│   │       └── features/                # 路由工厂：auth / admin / user / todo / storage
│   ├── web/                             # Next.js 16 前台（@app/web，端口 9840）
│   │   └── src/
│   │       ├── actions/auth.actions.ts  # Server Actions（登录 / 注册）
│   │       ├── app/                     # / 、/auth/login、/auth/register
│   │       ├── components/Header.tsx
│   │       ├── lib/                     # constants / server-client（SDK 单例）
│   │       └── providers/QueryProvider.tsx  # TanStack Query
│   └── admin/                           # Next.js 16 管理后台（@app/admin，端口 9845）
│       └── src/
│           ├── actions/auth.actions.ts  # Server Actions（@repo/aui defineAction）
│           ├── app/
│           │   ├── auth/                # login / register / forgot-password / reset-password
│           │   └── main/                # dashboard / todo / system/users / user-center
│           ├── components/              # AppHeader / AppMenu / AppSider
│           ├── lib/                     # constants / server-client / logger
│           ├── providers/AppProviders.tsx
│           ├── stores/                  # auth.store（Zustand + Immer）/ layout.store
│           └── proxy.ts                 # 中间件路由守卫（cookie）
├── packages/
│   ├── shared/                          # @repo/shared
│   │   └── src/
│   │       ├── schema/                  # Zod 共享 schema（auth / admin / user / todo / object-storage）
│   │       ├── dicts/                   # app-error-code / user-type 错误码与字典
│   │       ├── app-response.ts          # AppResponse 统一响应格式 + ResponseUtils
│   │       ├── logger.ts                # Pino 日志（createLogger）
│   │       ├── browser.ts               # 浏览器端子入口
│   │       └── utils/                   # nanoid / dayjs / md5 / tree / dict 等工具
│   ├── kits/                            # @repo/kits — 后端通用能力封装（无业务实体）
│   │   └── src/
│   │       ├── service-context.ts       # createServiceContext() 基建组合根工厂
│   │       ├── foundation/              # 横切基础：app-config / errors / logger / id-generation / scheduler
│   │       ├── infrastructure/          # 外部资源门面：database / redis-store / object-storage /
│   │       │                            # queue / token-signer / password-hasher / session-store
│   │       └── db/                      # createDb / pagination（四种分页）/ BaseEntity
│   ├── di/                              # @repo/di — DI 门面：InversifyJS 8 封装
│   │   └── src/
│   │       ├── di.ts                    # @Injectable() / @Inject()（写入自有 DiParamTypesKey 元数据）
│   │       ├── app-context.ts           # AppContext：Container + LifeCycleHost 组合根
│   │       ├── life-cycle-host.ts       # 生命周期调度（依赖拓扑排序 / 回滚 / 幂等）
│   │       └── life-cycle.ts            # LifeCycle / OnAppStart / OnAppStop 接口
│   ├── api-client/                      # @repo/api-client — 通用 HTTP + 鉴权管线（业务无关）
│   │   └── src/
│   │       ├── core/                    # api.client / credential-resolver / auth-injector / api-error
│   │       ├── strategies/              # BearerToken / ApiKey / OAuth2 / HMAC
│   │       ├── managers/                # localStorage / memory / cookie / env
│   │       └── providers/               # empty-check / expires-at
│   ├── sdk/                             # @repo/sdk
│   │   └── src/
│   │       └── server.client.ts         # ServerClient（全类型化业务 API，继承 api-client 的 ApiClient）
│   ├── ui/                              # @repo/ui — Base UI + shadcn 组件（src/components/ui/*）
│   └── aui/                             # @repo/aui — Ant Design 管理端组件库 + action 工具
├── docker/                              # Dockerfile.base / .server / .web + init-db.sql
├── docs/                                # pagination.md（分页指南）/ sdk-refactor.md
├── scripts/                             # cli.ts 脚手架生成器
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## Apps 详解

### apps/server — Hono HTTP 边界

`apps/server` 只做四件事：接收请求、Zod 校验、调用业务 service、映射错误。业务逻辑位于
`apps/server/src/modules/`（实体与迁移在 `src/database/`），通用能力位于 `@repo/kits`。

- **组合根**：`main.ts` 用 `createServiceContext({ db: { entities } })` 装配基建，再 `addService`
  注册业务仓储 / 服务，创建 `Hono` 实例，挂载全局中间件（CORS、请求上下文、请求日志）与五组路由
  （`/auth`、`/admin`、`/user`、`/todo`、`/storage`），统一 `notFound` 与 `onError`。
- **错误映射**：`lib/http.ts` 将业务抛出的错误（自带 `code` 数字）通过 `AppErrorCodes` 字典
  映射为 HTTP 状态码与中文文案，未知错误统一按系统错误（5001 / 500）处理。
- **鉴权中间件**：`lib/authentication.ts` 的 `requireAuth` 从 `Authorization: Bearer` 或
  `access-token` cookie 取 token，调用 `authService.verifyToken` 后把 `userId` 写入请求上下文。
- **请求上下文**：`lib/request-context.ts` 基于 `AsyncLocalStorage`，跨中间件与业务调用传递
  `userId`，避免参数透传。
- **请求日志**：`lib/request-logger.ts` 为每个请求生成 `requestId` 并写入 `X-Request-Id` 响应头，
  按状态码分级记录耗时、userId、IP 等上下文。
- **优雅关闭**：`program()` 监听 SIGINT / SIGTERM，先关 HTTP server，再 `runtime.stop()`
  （逆序释放 Db / Redis / ObjectStorage 连接）。

### apps/web — Next.js 16 前台

面向 C 端的前台应用，使用 **Base UI + shadcn/ui**（来自 `@repo/ui`）与 Tailwind 4，不依赖 Ant Design。

- 页面：`/`（首页）、`/auth/login`、`/auth/register`
- Server Actions（`actions/auth.actions.ts`）封装登录 / 注册，token 写入 httpOnly cookie
- `lib/server-client.ts` 提供 `ServerClient` 单例（localStorage 凭证管理）+ 服务端实例（cookie）
- `providers/QueryProvider.tsx` 注入 TanStack Query
- `next.config.ts`：`output: 'standalone'`、React Compiler、transpile `@repo/ui`

### apps/admin — Next.js 16 管理后台

面向后台的管理应用，使用 **Ant Design 6 + @repo/aui**，适合表格 / 表单 / 权限类页面。
登录使用**后台管理员**账号（`AdminEntity`，`/admin/*` 接口），与前台用户体系隔离。

- 页面：`/auth/login`（管理员登录）、`/main/dashboard`、`/main/todo`、
  `/main/system/users`、`/main/system/admins`（管理员管理）、`/main/user-center`
- 布局：`AppHeader` + `AppSider` + `AppMenu`，`main/layout.tsx` 标记 `force-dynamic`，
  SSR 侧通过 cookie 调用 `admin.getMe()` 做鉴权，失败 `redirect()` 到登录页
- 路由守卫：`proxy.ts` 中间件按 `PublicPaths` + cookie 重定向未登录 / 已登录用户
- Server Actions：`@repo/aui/action` 的 `defineAction` / `callAction` 统一返回
  `{ ok, data } | { ok: false, error }` 结构，简化错误处理
- 状态管理：Zustand + Immer（`auth.store` 保存 `adminInfo` / `layout.store`），
  `main/layout.tsx` SSR 预取管理员信息
- 首个管理员：`pnpm seed:admin`（默认 `admin@billy.local / admin123`，可用
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` 覆盖），随后可在「系统设置 → 管理员管理」中维护
- 静态样式提取：`pnpm --filter @app/admin gen:antd-css` 生成 antd 静态 CSS

## Packages 详解

### @repo/shared — 前后端共享层

Zod schema 单一事实源，同时派生 TypeScript 类型（`*.schema.ts` 导出 `XxxModel` / `XxxDto`）：

- `schema/`：auth / admin / user / todo / object-storage / base（分页、游标基类）
- `dicts/app-error-code.dict.ts`：错误码字典（`value` + `http` + `label`），业务抛错、server 映射、
  前端文案共用同一份定义
- `app-response.ts`：`AppResponse<T>` / `AppPageQueryResponse<T>` / `AppCursorQueryResponse<T>` 与
  `ResponseUtils`（`success` / `error` / `isSuccess`）
- `logger.ts`：Pino 封装 `createLogger(name, pretty)`，开发环境 pretty 彩色、生产 JSON
- 子入口：`@repo/shared/browser`（浏览器端安全导出）、`@repo/shared/logger`
- `utils/`：nanoid / dayjs / md5 / tree / dict / file / zod 等通用工具

### @repo/kits — 后端通用能力封装

纯能力集（**不持有任何业务实体**），由 `createServiceContext` 装配基建与基础能力：

- `db/`：`createDb(options)`（PostgreSQL DataSource 工厂，实体由应用注入）、
  `pagination.ts`（四种分页策略，见下文「分页」）、`base-entity.ts`（`BaseEntity`：
  `id` nanoid 主键 + `createdAt` / `updatedAt` / 软删除 `deletedAt`）
- `infrastructure/`：`Db` / `RedisStore` / `QueueManager` / `ObjectStorage` /
  `TokenSigner` / `SessionStore` / `PasswordHasher`（外部资源门面 + 生命周期）
- `foundation/`：`config/`（分片配置 bean：`DbConfig` / `RedisConfig` / `JwtConfig` /
  `StorageConfig` / `AuthConfig` / `LoggerConfig`，schema 校验 + 通用默认值，按需注入门面）+
  `Logger` / `IdGeneration` / `Scheduler` / `errors`（AppError / InfrastructureError）
- `service-context.ts`：`createServiceContext({ db?, redis?, jwt?, storage?, auth?, logger? })`
  基建组合根工厂：按传入分片装配对应组件（缺失分片不注册，用了即 DI 报错）；
  业务仓储 / 服务由应用层 `addService` 注册
- 继续 re-export `typeorm-transactional`（业务模块 `@Transactional()` 直接来自 `@repo/kits`）

### apps/server 业务模块

业务三层（service + repository + errors）位于 `apps/server/src/modules/{auth,admin,user,todo}`，
实体 / 迁移位于 `apps/server/src/database/`（`data-source.ts` 供 `db:generate` / `db:migrate`）：

```
modules/                     # 业务领域（service + repository + errors）
├── auth/         # auth.service.ts（register/login/forgot/reset/change-password/getMe/verifyToken）+ errors
├── admin/        # admin.service.ts（后台管理员 login/getMe/CRUD/resetPassword/changePassword/verifyToken）
│                 #   + admin.repository.ts + errors；token 带 type='admin'，与前台用户隔离
├── user/         # user.service.ts + user.repository.ts + errors
└── todo/         # todo.service.ts + todo.repository.ts + errors
database/
├── entities/     # UserEntity / TodoEntity / AdminEntity（继承 @repo/kits 的 BaseEntity）
└── migrations/   # TypeORM 迁移产物
```

**使用方式（应用组合根 `apps/server/src/main.ts`）：**

```ts
import { createServiceContext } from '@repo/kits'
import { TodoEntity } from './database/entities/todo-entity.js'
import { TodoRepository } from './modules/todo/todo.repository.js'
import { TodoService } from './modules/todo/todo.service.js'

const ctx = createServiceContext({
  db: { entities: [TodoEntity], sync: true },   // 实体由应用注入，kits 不持有实体
})
  .addService(TodoRepository)                   // 业务仓储 / 服务在应用层注册
  .addService(TodoService)

await ctx.start() // 生命周期启动：Db / Redis / ObjectStorage 按 @Inject 依赖序建连
const todoService = ctx.get(TodoService)
await ctx.stop() // 逆序释放资源（幂等，可重复调用）
```

**生命周期设计：**

- `@Injectable()` / `@Inject()`（`@repo/di`）是 `inversify` 原装饰器的包装：透传原逻辑（容器照常解析），同时把注入 token 写入**我们自己的元数据 key**（`DiParamTypesKey`），不依赖 inversify 内部键
- `LifeCycleHost` 依据 `DiParamTypesKey` 构建依赖图做 Kahn 拓扑排序——**调用方以任意顺序注册生命周期组件，宿主都保证「依赖先启动」**；检测到环直接报错
- `start()` 失败自动逆序回滚已启动组件；`stop()` 幂等、单组件失败收集日志不中断

**设计原则：**

- 通用能力（基础设施 / 横切基础 / 数据访问）归 `@repo/kits`，业务模块与实体 / 迁移归 `apps/server`
- 所有能力与业务服务都是 `@Injectable()` class，构造器注入依赖（统一使用项目自定义装饰器）
- 错误以 `Error` 子类抛出并携带 `code`，Hono 边界按 `code` 映射 HTTP 错误码与文案
- DTO / Zod 校验与 HTTP 错误转换只存在于 Hono 边界（`apps/server`）
- 业务错误保持原义，不包装成统一 `AppError`
- 基础设施服务隔离数据库、Redis、JWT 与对象存储等技术细节，业务层不感知具体实现
- 应用层只通过 `AppContext.get()` 取服务，不感知内部依赖图
- 无装饰器反射之外的魔法，兼容 Node type-stripping / esbuild / tsdown

### @repo/api-client — 通用 HTTP + 鉴权管线

业务无关的客户端基础设施，被 `@repo/sdk` 的 `ServerClient` 继承使用（依赖方向：`sdk → api-client → shared`）。

`ApiClient`（基于原生 fetch）的请求管线：

```
skipAuth 检查
  → CredentialResolver.resolve()（凭证校验 / acquire / refresh，并发去重）
  → AuthInjector.inject()（按 AuthStrategy 注入 headers / query / body）
  → cancelPrevious（相同在途请求去重，latest wins）
  → fetch() 发送请求
  → 错误处理：401 + 可刷新 → forceRefresh 重试一次；其余统一抛 ApiError
```

- `ServerClient extends ApiClient`（`@repo/sdk`）：按业务分组的全类型化方法
  （`auth` / `admin` / `user` / `todo` / `storage`），请求 / 响应类型全部来自 `@repo/shared`
- 认证策略：`BearerToken` / `ApiKey` / `OAuth2` / `HMAC`
- 凭证管理器：`localStorage` / `memory` / `cookie` / `env`
- 凭证供应器：`empty-check` / `expires-at`（配合 OAuth2 自动续期）
- 错误：统一 `ApiError`（可 JSON 序列化），区分网络异常与业务异常

```typescript
import { ServerClient } from '@repo/sdk'
import { LocalStorageCredentialsManager } from '@repo/api-client'
import type { BearerTokenCredentials } from '@repo/api-client'

const client = new ServerClient({
  baseUrl: 'http://localhost:9989',
  credentialsManager: new LocalStorageCredentialsManager<BearerTokenCredentials>('access-token'),
  callbacks: {
    onUnauthorized: () => window.location.replace('/auth/login'),
  },
})

// 公开接口（无需 token）
const { token, user } = await client.auth.login({ email, password })
await client.credentialsManager.setCredentials({ token })

// 需鉴权接口
const me = await client.auth.getMe()
const todos = await client.todo.cursorQuery({ size: 20 })
```

### @repo/ui — 共享组件库

Base UI + shadcn 风格的无样式组件（`src/components/ui/*`，约 60 个：button / dialog / table /
sidebar / toast / chart 等），Tailwind 4 主题变量由 `globals.css` 提供。重型组件按需从子路径引入
（`@repo/ui/components/ui/command` 等）。

### @repo/aui — Ant Design 管理端组件库

基于 Ant Design 6 的 admin 专用组件：

- 表格：`DataTable` / `PaginationTable` / `TableActions` / `PageToolbar`
- 列表：`DataList`（游标滚动加载）
- 表单：`ModalForm` / `FormRenderer` / `EditableInput`
- 存储：`StorageProvider` / `useStorage` / `ImageUpload` / `FileUpload` / `FilePreview` /
  `SortableFileList`（配合 `/storage/*` 接口）
- 其他：`DictTag` / `DisplayValue` / `Icon` / `PageLoading` / `Group` 等
- `action.ts`：`defineAction` / `callAction` —— Server Action 的 `{ ok, data } | { ok: false, error }`
  包装器，与 `useDisclosure` / `usePasteFiles` / `useRect` 等 hooks

## 架构设计

### 分层与数据流

```
浏览器 ── POST JSON ──→ Next.js（Server Actions / 客户端 SDK）── POST JSON ──→ Hono
                       （SSR）                                        │
                                                                      ├─ 业务 service ──→ PostgreSQL
                                                                      │                    (TypeORM)
                                                                      └─ 业务 service ──→ Redis / S3 / COS
```

分层规则：`apps/server`（HTTP 适配 + 业务模块 + 实体/迁移）→ `@repo/kits`（通用能力）→ 外部资源
（DB / Redis / S3 / COS）。前端通过 `@repo/sdk` 调用，请求 / 响应类型与后端共享 `@repo/shared`
的 Zod schema。

### 组合根与生命周期

组合根分两段：`@repo/kits` 的 `createServiceContext` 装配基建，`apps/server/src/main.ts` 在其上
注册业务：

- `createServiceContext({ db?, redis?, jwt?, storage?, auth?, logger? })`
  （`packages/kits/src/service-context.ts`）：按传入分片创建 `AppContext`
  （Container + LifeCycleHost）并装配对应基建 + 基础能力（无业务）；每个分片 zod 校验，
  缺失分片不注册 → 用了对应组件则 DI 报错
- `apps/server/src/main.ts`：`createServiceContext({ db: { entities, sync: true }, redis: {...}, jwt: {...} })`
  注入各能力分片配置，再 `.addConstant(ServerConfig, ...)` 注入应用业务配置（端口/认证策略），
  最后 `.addService(XxxRepository)` / `.addService(XxxService)` 注册业务仓储与服务
- `ctx.start()`：生命周期组件按 `@Inject` 依赖拓扑序执行 `onAppStart`
  （Db 初始化、Redis 连接、ObjectStorage 建桶/客户端）；任一失败逆序回滚已启动组件并抛错
- `ctx.stop()`：按拓扑逆序执行 `onAppStop` 释放资源，幂等，单个失败不阻断其余
- 生命周期组件通过 `ctx.addLifeCycleService(...)` 注册；启动顺序由 `@Inject` 声明自动推导，与注册顺序无关

### 认证

- JWT token，通过 `Authorization: Bearer` 或 `access-token` cookie 传递
- Hono `requireAuth` 中间件调用业务 `verifyToken`，把 `userId` 注入请求上下文；
  `requireAdminAuth` 校验管理员 token（payload 带 `type: 'admin'`），把 `adminId` 注入请求上下文
- 两类 token 严格隔离：用户 token 只能访问用户接口，管理员 token 只能访问 `/admin/*` 接口
- 公开接口（注册 / 登录 / 管理员登录 / 忘记密码 / 重置密码）不加 Guard
- Admin SSR 侧：`main/layout.tsx` 用 cookie 调 `getMe()`，失败 `redirect()`；`proxy.ts`
  中间件做首屏路由守卫
- Web 侧：`onUnauthorized` 回调 + Server Actions 返回 `ActionResult` 结构
- Admin 客户端：token 存 localStorage，同时写 httpOnly cookie 供 SSR 守卫使用

### API 设计

所有接口均为 `POST`，请求体由 Zod schema 校验，响应统一包装为 `AppResponse<T>`：

**成功响应：**

```json
{ "code": 0, "data": { ... } }
```

**业务异常响应：**

```json
{ "code": 1000, "message": "邮箱不存在" }
```

| 路由                                 | 说明             | 鉴权 |
| ------------------------------------ | ---------------- | ---- |
| `POST /auth/register`                | 注册             | 否   |
| `POST /auth/login`                   | 登录             | 否   |
| `POST /auth/forgot-password`         | 忘记密码         | 否   |
| `POST /auth/reset-password`          | 重置密码         | 否   |
| `POST /auth/get-me`                  | 获取当前用户     | 是   |
| `POST /auth/update-info`             | 更新个人信息     | 是   |
| `POST /auth/change-password`         | 修改密码         | 是   |
| `POST /admin/login`                  | 管理员登录       | 否   |
| `POST /admin/get-me`                 | 获取当前管理员   | 是*  |
| `POST /admin/update-info`            | 更新个人信息     | 是*  |
| `POST /admin/change-password`        | 修改密码         | 是*  |
| `POST /admin/create`                 | 创建管理员       | 是*  |
| `POST /admin/page-query`             | 管理员分页查询   | 是*  |
| `POST /admin/detail`                 | 管理员详情       | 是*  |
| `POST /admin/update`                 | 更新管理员       | 是*  |
| `POST /admin/remove`                 | 删除管理员       | 是*  |
| `POST /admin/reset-password`         | 重置管理员密码   | 是*  |
| `POST /user/create`                  | 创建用户         | 是   |
| `POST /user/page-query`              | 用户分页查询     | 是   |
| `POST /user/detail`                  | 用户详情         | 是   |
| `POST /user/update`                  | 更新用户         | 是   |
| `POST /user/remove`                  | 删除用户         | 是   |
| `POST /user/reset-password`          | 重置用户密码     | 是   |
| `POST /todo/create`                  | 创建 Todo        | 是   |
| `POST /todo/page-query`              | Todo 页码分页    | 是   |
| `POST /todo/cursor-query`            | Todo 游标分页    | 是   |
| `POST /todo/detail`                  | Todo 详情        | 是   |
| `POST /todo/update`                  | 更新 Todo        | 是   |
| `POST /todo/remove`                  | 删除 Todo        | 是   |
| `POST /storage/get-presigned-url`    | 获取上传预签名 URL | 是 |
| `POST /storage/get-download-url`     | 获取下载预签名 URL | 是 |
| `POST /storage/get-temporary-credentials` | 获取 STS 临时凭证 | 是 |

### 分页

`packages/kits/src/db/pagination.ts` 提供四种分页策略（构建在 TypeORM QueryBuilder 之上）：

- **`pageWith`** — 单表 `LIMIT/OFFSET` 页码分页，返回 `total/page/size`
- **`pageWithDeferred`** — 两阶段 Offset 分页：先主键分页，再按主键加载详情，适合复杂联表表格
- **`cursorPageWith`** — 单表 Seek/Cursor 分页（复合键），适合无限滚动与持续新增的数据流
- **`cursorPageWithDeferred`** — 两阶段 Cursor 分页：先定位主键与 cursor，再查询当页 JOIN 数据

项目约定：后台 `DataTable` 默认普通分页，滚动 `DataList` 默认 Cursor 分页；一对多 JOIN 或重聚合
查询优先使用对应的 Deferred 方法。完整原理、SQL、索引与选型指南见
[分页设计指南](docs/pagination.md)。

### 日志

`@repo/shared` 提供 `createLogger(name, pretty?)`；kits / 业务内通过 `@Logger()` 装饰器自动以
宿主类名创建 logger：

- 开发环境 `pretty=true` → pino-pretty 彩色输出
- 生产环境默认 JSON，由容器日志系统收集
- `apps/server` 的请求日志中间件为每个请求生成 `X-Request-Id`，按状态码分级记录
  （`<400` info、`4xx` warn、`5xx` error），附带耗时、userId、IP 等上下文

## CLI 脚手架

`scripts/cli.ts`（`pnpm cli`）是 Billy Workspace 生成器，基于 `commander` + `@inquirer/prompts` +
`mem-fs-editor` 模板引擎，可生成：

- `client` — SDK 客户端片段
- `service` — 业务服务
- `crud` — 完整 CRUD 模块（service + repository + errors + schema + 路由提示）
- `package` — 新 workspace 包
- `utils` — 共享工具函数

```bash
pnpm cli            # 交互式选择模板
pnpm cli --help     # 查看参数
```

生成 CRUD 后会提示手动补全：实体定义、schema 导出、错误码注册，并运行 `pnpm db:gen` 生成迁移。

## 脚本

| 命令                | 说明                                    |
| ------------------- | --------------------------------------- |
| `pnpm cli`          | 脚手架生成器                            |
| `pnpm dev:pkgs`     | 并行 watch 构建 packages                |
| `pnpm build:pkgs`   | 构建 packages                           |
| `pnpm dev:server`   | 启动 Hono 开发服务器（9989，tsx watch） |
| `pnpm dev:web`      | 启动 Web 前台（9840）                   |
| `pnpm dev:admin`    | 启动 Admin 后台（9845）                 |
| `pnpm build`        | 全量构建（turbo）                       |
| `pnpm start:server` | 启动生产 Server                         |
| `pnpm start:web`    | 启动生产 Web                            |
| `pnpm db:gen <name>`| 生成 TypeORM 迁移（写入 `apps/server/src/database/migrations/`） |
| `pnpm db:migrate`   | 执行 TypeORM 迁移                       |
| `pnpm seed:admin`   | 初始化第一个后台管理员（`admin@billy.local / admin123`，可用环境变量覆盖） |
| `pnpm docker:up`    | `docker compose up -d --build`          |
| `pnpm clean`        | 清理 node_modules / dist / 缓存         |

## Docker

### Compose 服务（依赖一键起）

```bash
docker compose up -d postgres redis minio   # 仅基础设施
pnpm docker:up                              # 全部（含 server + web）
```

| 服务     | 镜像 / 构建             | 端口映射                    |
| -------- | ----------------------- | --------------------------- |
| postgres | postgres:17-alpine      | `15432:5432`（含 init-db.sql）|
| redis    | redis:7-alpine          | `6380:6379`                 |
| minio    | minio/minio             | `19000:9000` / `19001:9001` |
| server   | docker/Dockerfile.server| `9989:9989`                 |
| web      | docker/Dockerfile.web   | `3001:3001`                 |

### 镜像构建

```bash
# 先构建基础镜像（node 24.14.1 + pnpm 11.15.0 + 运维工具 bash/curl/wget/jq/tzdata）
./build-base-image.sh
# 等价于
docker build -t node24-pnpm11:1.0 -f docker/Dockerfile.base .

# 构建 server / web 镜像
docker build -t billy-server:latest -f docker/Dockerfile.server .
docker build -t billy-web:latest -f docker/Dockerfile.web .
```

### 特性

- **server**：multi-stage + `pnpm deploy --prod` 提取运行时依赖，仅携带编译产物与生产依赖，
  非 root 用户运行
- **web**：Next.js `output: 'standalone'` 模式，产物不携带源码与 devDependencies
- **基础镜像**：内置 `bash / curl / wget / jq / bind-tools / tzdata（Asia/Shanghai）` 等运维工具，
  并切换 npmmirror 镜像源

## 文档

- [docs/pagination.md](docs/pagination.md) — 分页设计指南（Offset / Cursor / Deferred 选型与实现）
- [docs/sdk-refactor.md](docs/sdk-refactor.md) — SDK 职责拆分说明（ApiClient / CredentialResolver / AuthInjector）
