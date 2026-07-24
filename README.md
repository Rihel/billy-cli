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

| 层 | 选型 | 理由 |
|---|---|---|
| 构建系统 | pnpm + Turbo | monorepo 依赖管理 + 增量缓存 |
| 服务端框架 | NestJS 11 | 企业级 DI/AOP，nestjs-trpc 深度集成 |
| API 层 | tRPC | 全链路类型推导，零契约文档 |
| ORM | Drizzle ORM | 无 runtime、类型原生、SQL-like API |
| 前端框架 | Next.js 16 App Router | RSC + SSR + Server Actions |
| 前后端共享 | Zod | 同一 schema 定义类型 + 校验 |
| UI 组件 | Ant Design Pro 6 | ProTable / ModalForm 开箱即用 |
| 状态管理 | Zustand + Immer | 轻量、不可变、无 boilerplate |
| 样式 | Tailwind 4 | 原子化 CSS，零心智负担 |
| 日志 | Pino | 结构化日志，全链路覆盖 |
| 缓存 | Redis（ioredis） | Session / 限流 / 热数据 |
| 构建工具 | tsdown | 比 tsc 快一个数量级的 bundler |

## 快速开始

### 前置条件

- Node.js >= 20
- pnpm >= 11
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

### 启动

```bash
# 终端 1：启动 packages（shared / db / ui）的 watch 构建
pnpm dev:pkgs

# 终端 2：启动 NestJS 服务（port 9989）
pnpm dev:server

# 终端 3：启动 Next.js 前端（port 9845）
pnpm dev:web
```

也可全量并行启动（不过日志会比较密集）：

```bash
pnpm dev:pkgs & pnpm dev:server & pnpm dev:web
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
             lib/server-trpc.ts    lib/trpc.ts
             （RSC / Server Actions）  （SPA 客户端）
```

### 认证

- JWT token，通过 `Authorization: Bearer` 或 `cookie` 传递
- `TrpcAppContext` 在 tRPC context 层自动解析 token，注入 `userId`
- `AuthMiddleware` 装饰器按路由粒度控制鉴权
- SSR 侧通过 proxy middleware 做路由守卫

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

`DbService` 提供两种分页策略：

- **`paginate`** — 单表简单分页，一个查询完成
- **`paginateDeferred`** — 两阶段 Deferred Join 分页
  - Stage 1：只在主表取 ID + COUNT（无 JOIN）
  - Stage 2：用 ID 列表执行完整 JOIN 查询
  - 适用于多表 LEFT JOIN 的复杂查询，性能远优于传统 `LIMIT/OFFSET` + JOIN

## 项目结构

```
├── apps/
│   ├── server/
│   │   └── src/
│   │       ├── @generated/        # tRPC 类型定义（自动生成）
│   │       ├── infra/             # 基础设施 DbService / RedisService
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
│       └── src/
│           ├── actions/           # Server Actions
│           ├── app/               # App Router 页面
│           │   ├── auth/          # 登录 / 注册 / 重置密码
│           │   └── main/          # 仪表盘 / Todo / 系统设置
│           ├── lib/               # trpc 客户端 / 认证 / 常量
│           ├── providers/         # React Context Providers
│           ├── stores/            # Zustand stores
│           └── proxy.ts           # SSR 路由守卫
├── packages/
│   ├── db/
│   │   ├── src/entities.ts        # Drizzle schema
│   │   ├── src/db.ts              # 数据库连接
│   │   └── drizzle/               # 迁移文件
│   ├── shared/
│   │   └── src/
│   │       ├── schema/            # Zod 共享 schema
│   │       ├── logger.ts          # Pino 日志
│   │       └── dayjs.ts           # dayjs 配置
│   └── ui/
│       ├── src/components/        # 共享 React 组件
│       └── src/lib/               # cn() 等工具
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## 脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev:pkgs` | 并行 watch packages 构建 |
| `pnpm dev:server` | 启动 NestJS 开发服务器 |
| `pnpm dev:web` | 启动 Next.js 开发服务器 |
| `pnpm gen:trpc` | 生成 tRPC 类型定义 |
| `pnpm db:gen` | 生成 Drizzle 迁移文件 |
| `pnpm db:migrate` | 执行数据库迁移 |
