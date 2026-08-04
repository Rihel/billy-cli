# Billy

> 一套现代化的全栈应用模板，开发体验拉满。后端逐步从 NestJS + kits 迁移到 Effect-TS + core。

## 技术栈

```
apps/
├── server   — NestJS 11 + Drizzle ORM + PostgreSQL + Redis
├── web      — Next.js 16 App Router + Ant Design Pro 6 + Tailwind 4
└── admin    — 管理后台
packages/
├── db       — Drizzle ORM schema + 数据库连接 + migration
├── shared   — Zod schemas + 错误码字典 + 响应工具（前后端共享）
├── core     — Effect-TS 业务层：Config / DB / Redis / JWT / Storage + Auth / User / Todo
├── sdk      — ServerClient（全类型化业务 API 调用）
├── ui       — 共享 UI 组件（Ant Design + Tailwind）
├── kits     — NestJS 工具包（DB / Redis / Storage / 日志 / 错误）[旧]
└── aui      — AI UI 组件库
```

| 层         | 选型                          | 理由                                       |
| ---------- | ----------------------------- | ------------------------------------------ |
| 构建系统   | pnpm + Turbo                  | monorepo 依赖管理 + 增量缓存               |
| 服务端框架 | NestJS 11 / Effect-TS         | NestJS（当前 server）+ Effect-TS（core 包） |
| API 层     | POST JSON（NestJS Controller）| 全类型化 SDK 封装，零额外运行时             |
| ORM        | Drizzle ORM                   | 无 runtime、类型原生、SQL-like API         |
| 前端框架   | Next.js 16 App Router         | RSC + SSR + Server Actions                 |
| 前后端共享 | Zod                           | 同一 schema 定义类型 + 校验                |
| UI 组件    | Ant Design Pro 6              | ProTable / ModalForm 开箱即用              |
| 状态管理   | Zustand + Immer               | 轻量、不可变、无 boilerplate               |
| 样式       | Tailwind 4                    | 原子化 CSS，零心智负担                     |
| 日志       | Pino                          | 结构化日志，开发环境 pretty，生产环境 JSON |
| 缓存       | Redis（ioredis）              | 完整 Set / List / Hash / PubSub / 分布式锁 |
| 构建工具   | tsdown                        | 比 tsc 快一个数量级的 bundler              |
| 容器化     | Docker multi-stage            | server + web + admin 独立部署              |

## 快速开始

### 前置条件

- Node.js >= 20
- pnpm >= 11（`corepack enable && corepack prepare pnpm@11.15.0 --activate`）
- PostgreSQL
- Redis（可选，默认连接 localhost:6379）

### 安装

```bash
pnpm install
```

### 环境变量

创建 `apps/server/.env`：

```env
DB_URL=postgresql://user:password@localhost:5432/billy
REDIS_URL=redis://localhost:6379/0
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=7d
```

创建 `apps/web/.env.local`：

```env
NEXT_PUBLIC_SERVER_URL=http://localhost:9989
SERVER_URL=http://localhost:9989
```

### 数据库

```bash
# 生成迁移文件
pnpm db:gen

# 执行迁移
pnpm db:migrate
```

### 启动（开发）

```bash
# 终端 1：启动 packages（shared / db / ui / kits / sdk）的 watch 构建
pnpm dev:pkgs

# 终端 2：启动 NestJS 服务（port 9989）
pnpm dev:server

# 终端 3：启动 Next.js 前端（port 9845）
pnpm dev:web
```

### 构建与启动（生产）

```bash
# 构建全部
pnpm build

# 分别启动
pnpm start:server
pnpm start:web

# 或 Docker
docker compose up
```

## Packages 详解

### @repo/core — Effect-TS 业务核心

基于 Effect-TS 的后端业务层，通过 Layer 做依赖注入和资源生命周期管理。

**分层结构：**

```
effects/          # Effect 工具函数
├── parse-input   # Zod 校验入参 → AppError
├── to-response   # Effect<T, AppError> → AppResponse<T>
└── from-promise  # Promise → Effect（typed error）
infra/            # 基础设施层
├── config        # Zod schema 驱动配置，支持 hardcode / env
├── db            # Drizzle ORM 封装：query / transaction / pageQuery / cursorQuery
├── redis         # ioredis 封装：String / Set / List / Hash / PubSub / 分布式锁 / JSON
├── jwt           # JWT sign / verify
├── password      # bcrypt hash / verify（typed error）
├── logger        # Pino 日志
└── storage/      # S3 / COS 对象存储（策略模式，STS 临时凭证支持）
biz/              # 业务层
├── auth          # 注册 / 登录 / 忘记密码 / 重置密码 / 改密 / Token 验证
├── user          # 用户 CRUD + 分页
└── todo          # Todo CRUD + 分页 + 游标查询
errors.ts         # AppError (TaggedError) + makeError
layers.ts         # makeAppLayer() 一站式组装
```

**使用方式：**

```ts
import { ManagedRuntime } from 'effect'
import { makeAppLayer, AuthService, UserService } from '@repo/core'

const runtime = ManagedRuntime.make(makeAppLayer())
const program = Effect.gen(function* () {
  const auth = yield* AuthService
  const user = yield* UserService
  // ...
})

await runtime.runPromise(program)
```

**设计原则：**
- 所有返回值 `Effect<A, AppError>`，不做 `catchAll` 吞错误——错误转换由 HTTP 层负责
- 每个 public 方法入口调用 `parseInput(schema, input)`，运行时 Zod 校验
- 日志通过 `Effect.tap` 挂载，不侵入主逻辑
- 不使用 NestJS 装饰器，纯 Effect-TS 函数式风格
- `fromPromise()` 统一 Promise → Effect 边界，typed error 进错误通道


## 架构设计

### 数据流

```
浏览器 ── POST JSON ──→ Next.js ── POST JSON ──→ NestJS ── Drizzle ──→ PostgreSQL
                         (SSR)       │                      │
                                      │                      └── Redis
                                      │
                           ┌──────────┴──────────┐
                           │                     │
                    lib/server.ts          lib/client.ts
                    （ServerClient）       （ServerClient）
                    RSC / Server Actions   浏览器端
```

### 认证

- JWT token，通过 `Authorization: Bearer` 或 `cookie` 传递
- `AuthGuard` 在 NestJS 控制器层校验 JWT，注入 `userId`
- 公开接口（登录 / 注册 / 忘记密码 / 重置密码）不用 Guard
- SSR 侧通过 try/catch + `redirect()` 做路由守卫
- 客户端通过 `onUnauthorized` 回调自动跳转登录页
- `main/layout.tsx` 标记 `dynamic = 'force-dynamic'` 确保每次请求都校验认证

### API 设计

所有接口均为 `POST`，响应统一包装为 `AppResponse<T>` 格式：

**成功响应**：
```json
{
  "code": 0,
  "data": { ... }
}
```

**业务异常响应**：
```json
{
  "code": 1000,
  "message": "邮箱不存在"
}
```

路由按模块划分：

| 路由 | 说明 | 鉴权 |
|------|------|------|
| `POST /auth/register` | 注册 | 否 |
| `POST /auth/login` | 登录 | 否 |
| `POST /auth/forgot-password` | 忘记密码 | 否 |
| `POST /auth/reset-password` | 重置密码 | 否 |
| `POST /auth/get-me` | 获取当前用户 | 是 |
| `POST /auth/update-info` | 更新个人信息 | 是 |
| `POST /auth/change-password` | 修改密码 | 是 |
| `POST /todo/*` | Todo CRUD | 是 |
| `POST /user/*` | 用户管理 | 是 |
| `POST /storage/*` | 存储服务 | 是 |

### ServerClient SDK

`@repo/sdk` 提供 `ServerClient` 封装，继承 `ApiClient`，自动处理鉴权和响应解包：

```typescript
import { ServerClient, BearerTokenStrategy, MemoryCredentialsManager } from '@repo/sdk'

const client = new ServerClient({
  baseUrl: 'http://localhost:9989',
  credentialsManager: new MemoryCredentialsManager(),
  authStrategy: new BearerTokenStrategy(),
  callbacks: {
    onUnauthorized: () => router.push('/auth/login'),
  },
})

// 公开接口（无需 token）
const { token, user } = await client.auth.login({ email, password })

// 设置 token 后自动带上鉴权头
await client.credentialsManager.setCredentials({ token })

// 需鉴权的接口
const me = await client.auth.getMe()
const todos = await client.todo.findManyCursor({ size: 20 })
```

前端通过 `lib/client.ts` 获取单例，`useServerClient()` hook 在 React 组件中使用。

服务端（Server Actions / RSC）通过 `lib/server.ts` 创建实例，从 httpOnly cookie 获取 token。

### 分页

完整原理、SQL、索引、联表策略和前端缓存说明参见
[分页设计指南](docs/pagination.md)。

`DbService` 提供四种分页策略：

- **`paginate`** — 单表 `LIMIT/OFFSET` 页码分页，返回 `total/page/size`。
- **`paginateDeferred`** — 两阶段 Offset 分页，适合需要总数和跳页的复杂联表表格。
- **`paginateCursor`** — 单表 Seek/Cursor 分页，适合无限滚动和持续新增的数据流。
- **`paginateCursorDeferred`** — 两阶段 Cursor 分页，先取主表 ID 与 cursor，再查询当页 JOIN 数据。

项目约定：后台 `DataTable` 默认使用普通分页，滚动 `DataList` 默认使用 Cursor
分页；一对多 JOIN 或重聚合查询优先使用对应的 Deferred 方法。

### 日志

`@repo/shared` 提供 `createLogger(name, pretty?)`：

- 开发环境传入 `pretty=true` → pino-pretty 彩色打印到控制台
- 生产环境不传或传 `false` → 纯 JSON，由容器日志系统收集

```typescript
// apps/server/src/main.ts
createLogger('bootstrap', appConfig.isDev)

// production 输出示例
{"level":30, "time":1690000000000, "name":"bootstrap", "msg":"服务已启动 http://localhost:9989"}
```

## 项目结构

```
├── apps/
│   ├── server/
│   │   └── src/
│   │       ├── config.ts
│   │       ├── main.ts
│   │       ├── root.module.ts
│   │       ├── guards/          # AuthGuard（JWT 鉴权）
│   │       ├── decorators/      # @UserId() 参数装饰器
│   │       ├── filters/         # AppExceptionFilter（全局异常）
│   │       ├── interceptors/    # ResponseInterceptor（统一包装 + 状态码）
│   │       ├── infra/           # DbService, RedisService, InfraModule
│   │       └── modules/
│   │           ├── auth/        # 注册 / 登录 / 密码重置
│   │           ├── todo/        # Todo CRUD
│   │           ├── user/        # 用户管理
│   │           └── storage/     # 文件存储（S3/COS）
│   └── web/
│       ├── scripts/
│       │   └── start.sh         # standalone 启动脚本
│       └── src/
│           ├── actions/         # Server Actions
│           ├── app/             # App Router 页面
│           │   ├── auth/        # 登录 / 注册 / 重置密码
│           │   └── main/
│           │       ├── dashboard/     # 仪表盘
│           │       ├── todo/          # Todo 管理
│           │       ├── system/users/  # 用户管理（CRUD）
│           │       ├── error.tsx      # 布局级错误边界
│           │       └── layout.tsx     # SSR 预取 + 鉴权
│           ├── lib/
│           │   ├── client.ts     # 客户端 ServerClient 单例
│           │   ├── server.ts     # 服务端 ServerClient（cookie）
│           │   ├── auth.ts       # 认证存储
│           │   └── constants.ts  # 路由常量
│           ├── providers/
│           │   └── AppProviders.tsx  # Ant Design + TanStack Query
│           ├── stores/
│           │   └── auth.store.tsx    # Zustand + Immer
│           └── proxy.ts          # SSR 路由守卫
├── packages/
│   ├── db/
│   │   ├── src/entities.ts      # Drizzle schema
│   │   ├── src/db.ts            # 数据库连接
│   │   └── drizzle/             # 迁移文件
│   ├── sdk/
│   │   └── src/core/
│   │       ├── api.client.ts      # 基础 HTTP 客户端（鉴权、自动重试）
│   │       ├── server.client.ts   # 全类型化业务 API 调用
│   │   │       ├── interfaces.ts      # 鉴权抽象
│   │       ├── strategies/        # BearerToken / ApiKey / OAuth2 / HMAC
│   │       └── managers/          # localStorage / memory / cookie / env
│   ├── shared/
│   │   └── src/
│   │       ├── schema/          # Zod 共享 schema
│   │       ├── dicts/           # 错误码字典
│   │       └── logger.ts        # Pino 日志
│   └── ui/
│       ├── src/components/      # 共享 React 组件
│       └── src/lib/             # cn() 等工具
├── docker/
│   ├── Dockerfile.base          # 基础镜像
│   ├── Dockerfile.server        # 服务端 multi-stage
│   ├── Dockerfile.web           # Web 端 standalone
│   └── init-db.sql              # 数据库初始化 DDL
├── docs/
│   └── pagination.md            # 分页设计指南
├── scripts/
│   └── cli/                     # 模板生成 CLI
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## 脚本

| 命令              | 说明                     |
| ----------------- | ------------------------ |
| `pnpm dev:pkgs`   | 并行 watch packages 构建 |
| `pnpm build:pkgs` | 构建 packages            |
| `pnpm dev:server` | 启动 NestJS 开发服务器   |
| `pnpm dev:web`    | 启动 Next.js 开发服务器  |
| `pnpm build`      | 全量构建（turbo）        |
| `pnpm start:server` | 启动生产 Server        |
| `pnpm start:web`  | 启动生产 Web             |
| `pnpm db:gen`     | 生成 Drizzle 迁移文件    |
| `pnpm db:migrate` | 执行数据库迁移           |

## Docker

### 构建

```bash
# 先构建基础镜像（含 node 24 + pnpm 11 + 运维工具）
docker build -t node24-pnpm11:1.0 -f docker/Dockerfile.base .

# 构建 web 镜像
docker build -t billy-web:latest -f docker/Dockerfile.web .

# 构建 server 镜像
docker build -t billy-server:latest -f docker/Dockerfile.server .
```

### 特性

- **web**：Next.js `output: 'standalone'` 模式，产物仅 50MB+，不携带源码和 devDependencies
- **server**：pnpm deploy 提取运行时依赖，仅携带编译产物
- **基础镜像**：内置 `bash / curl / wget / jq / tzdata（Asia/Shanghai）` 等运维工具
