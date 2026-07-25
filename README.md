# Billy

> 一套现代化的全栈应用模板，开发体验拉满。

## 技术栈

```
apps/
├── server   — NestJS 11 + tRPC + Drizzle ORM + PostgreSQL + Redis
├── web      — Next.js 16 App Router + Ant Design Pro 6 + Tailwind 4
packages/
├── db       — Drizzle ORM schema + migration
├── shared   — Zod schemas + 工具函数（前后端共享）
├── ui       — 共享 UI 组件（Ant Design + Tailwind）
```

| 层         | 选型                  | 理由                                       |
| ---------- | --------------------- | ------------------------------------------ |
| 构建系统   | pnpm + Turbo          | monorepo 依赖管理 + 增量缓存               |
| 服务端框架 | NestJS 11             | 企业级 DI/AOP，nestjs-trpc 深度集成        |
| API 层     | tRPC                  | 全链路类型推导，零契约文档                 |
| ORM        | Drizzle ORM           | 无 runtime、类型原生、SQL-like API         |
| 前端框架   | Next.js 16 App Router | RSC + SSR + Server Actions                 |
| 前后端共享 | Zod                   | 同一 schema 定义类型 + 校验                |
| UI 组件    | Ant Design Pro 6      | ProTable / ModalForm 开箱即用              |
| 状态管理   | Zustand + Immer       | 轻量、不可变、无 boilerplate               |
| 样式       | Tailwind 4            | 原子化 CSS，零心智负担                     |
| 日志       | Pino                  | 结构化日志，开发环境 pretty，生产环境 JSON |
| 缓存       | Redis（ioredis）      | 完整 Set / List / Hash / PubSub / 分布式锁 |
| 构建工具   | tsdown                | 比 tsc 快一个数量级的 bundler              |
| 容器化     | Docker multi-stage    | server + web 独立部署，Next.js standalone  |

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
# 终端 1：启动 packages（shared / db / ui）的 watch 构建
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

## 架构设计

### 数据流

```
浏览器 ── HTTP ──→ Next.js ── tRPC ──→ NestJS ── Drizzle ──→ PostgreSQL
                    (SSR)      │                     │
                               │                     └── Redis
                               │
                    ┌──────────┴──────────┐
                    │                     │
             lib/server-trpc.ts    lib/client-trpc.ts
             （RSC / Server Actions）  （SPA 客户端）
```

### 认证

- JWT token，通过 `Authorization: Bearer` 或 `cookie` 传递
- `TrpcAppContext` 在 tRPC context 层自动解析 token，注入 `userId`
- `AuthMiddleware` 装饰器按路由粒度控制鉴权
- SSR 侧通过 try/catch + `redirect()` 做路由守卫
- 客户端通过 `unauthorizedLink`（trpc-links.ts）自动跳转登录页
- `main/layout.tsx` 标记 `dynamic = 'force-dynamic'` 确保每次请求都校验认证

### tRPC 路由

所有 API 通过 `nestjs-trpc` 以 decorator 方式声明：

```typescript
@Router({ alias: 'todo' })
@UseMiddlewares(AuthMiddleware)
export class TodoRouter {
  @Mutation({ input: CreateTodoDto })
  create(@Input() input: z.infer<typeof CreateTodoDto>) { ... }

  @Query({ input: PageQueryTodoDto })
  findMany(@Input() input: z.infer<typeof PageQueryTodoDto>) { ... }
}
```

生成类型定义供客户端消费：

```bash
pnpm gen:trpc
```

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
createLogger('bootstrap', appConfig.isDev)  // NODE_ENV 控制

// production 输出示例
{"level":30, "time":1690000000000, "name":"bootstrap", "msg":"服务已启动 http://localhost:9989"}
```

## 项目结构

```
├── apps/
│   ├── server/
│   │   └── src/
│   │       ├── @generated/        # tRPC 类型定义（自动生成）
│   │       ├── infra/
│   │       │   ├── db.service.ts      # Drizzle CRUD + 分页
│   │       │   ├── redis.service.ts   # Set/List/Hash/Lock/PubSub/JSON
│   │       │   └── infra.module.ts    # Global Module
│   │       ├── middlewares/       # 鉴权中间件
│   │       ├── modules/
│   │       │   ├── auth/          # 注册 / 登录 / 密码重置
│   │       │   ├── todo/          # Todo CRUD
│   │       │   └── user/          # 用户管理
│   │       ├── config.ts
│   │       ├── main.ts
│   │       ├── logger.module.ts
│   │       ├── logger.service.ts
│   │       ├── root.module.ts
│   │       └── trpc.context.ts
│   └── web/
│       ├── scripts/
│       │   └── start.sh           # standalone 启动脚本
│       └── src/
│           ├── actions/           # Server Actions
│           ├── app/               # App Router 页面
│           │   ├── auth/          # 登录 / 注册 / 重置密码
│           │   ├── main/
│           │   │   ├── dashboard/     # 仪表盘
│           │   │   ├── todo/          # Todo 管理
│           │   │   ├── system/users/  # 用户管理（CRUD）
│           │   │   ├── error.tsx      # 布局级错误边界
│           │   │   └── layout.tsx     # SSR 预取 + 鉴权
│           │   ├── error.tsx      # 全局错误边界
│           │   └── layout.tsx     # 根 Layout
│           ├── lib/
│           │   ├── client-trpc.ts     # 客户端 tRPC
│           │   ├── server-trpc.ts     # 服务端 tRPC（RSC / Server Actions）
│           │   ├── trpc-links.ts      # 统一未授权处理
│           │   ├── auth.ts            # 认证存储
│           │   └── constants.ts       # 路由常量
│           ├── providers/
│           │   └── AppProviders.tsx    # Ant Design + tRPC + TanStack Query
│           ├── stores/
│           │   └── auth.store.tsx     # Zustand + Immer
│           ├── proxy.ts           # SSR 路由守卫
│           └── next.config.ts     # standalone output, react compiler
├── packages/
│   ├── db/
│   │   ├── src/entities.ts        # Drizzle schema
│   │   ├── src/db.ts              # 数据库连接
│   │   └── drizzle/               # 迁移文件
│   ├── shared/
│   │   └── src/
│   │       ├── schema/            # Zod 共享 schema
│   │       ├── logger.ts          # Pino 日志（条件 pretty）
│   │       └── dayjs.ts           # dayjs 配置
│   └── ui/
│       ├── src/components/        # 共享 React 组件
│       └── src/lib/               # cn() 等工具
├── docker/
│   ├── Dockerfile.base        # 基础镜像（node 24 + pnpm 11 + 运维工具）
│   ├── Dockerfile.server      # 服务端 multi-stage 构建
│   ├── Dockerfile.web         # Web 端 standalone multi-stage 构建
│   └── init-db.sql            # 数据库初始化 DDL
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## 脚本

| 命令                | 说明                     |
| ------------------- | ------------------------ |
| `pnpm dev:pkgs`     | 并行 watch packages 构建 |
| `pnpm build:pkgs`   | 构建 packages            |
| `pnpm dev:server`   | 启动 NestJS 开发服务器   |
| `pnpm dev:web`      | 启动 Next.js 开发服务器  |
| `pnpm build`        | 全量构建（turbo）        |
| `pnpm start:server` | 启动生产 Server          |
| `pnpm start:web`    | 启动生产 Web             |
| `pnpm gen:trpc`     | 生成 tRPC 类型定义       |
| `pnpm db:gen`       | 生成 Drizzle 迁移文件    |
| `pnpm db:migrate`   | 执行数据库迁移           |

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
