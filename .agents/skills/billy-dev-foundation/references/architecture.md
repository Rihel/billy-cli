# 架构与数据流（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分，由主 SKILL.md 引用。
> 开始任何任务前先阅读。

## 1. 工程是什么

billy-cli 是一套**全栈应用 Monorepo 模板**：pnpm + Turbo 构建，TypeScript 全栈。
后端「Hono 薄边界 + InversifyJS 业务核心」，前端两套独立入口（Web 前台 / Admin 后台）。

## 2. 技术栈速览

| 层 | 选型 |
| --- | --- |
| 构建 | pnpm + Turbo（`turbo.json` 按依赖拓扑编排） |
| 服务端 HTTP | Hono 4（`apps/server`，端口 9989） |
| 业务核心 | `@repo/core`（modules/<业务>/{service, repository, errors}） |
| 依赖注入 | InversifyJS 8 门面（`@repo/di`：`@Injectable`/`@Inject` + AppContext 组合根 + 生命周期） |
| ORM | TypeORM（`@repo/db`，PostgreSQL） |
| 契约 / 共享 | Zod + 字典 + 响应工具（`@repo/shared`） |
| 前台 | Next.js 16 App Router + Base UI + shadcn/ui + Tailwind 4（`apps/web`，9840） |
| 后台 | Next.js 16 + Ant Design 6 + `@repo/aui` + Zustand/Immer + TanStack Query（`apps/admin`，9845） |
| API 客户端 | `@repo/api-client`（通用）+ `@repo/sdk`（业务全类型化 ServerClient） |

## 3. 分层架构与依赖方向（最重要的心智模型）

```
apps/server   Hono 路由工厂（薄边界：Zod 校验 + 调 core + 错误映射）
   ↓ 只依赖
@repo/core    业务核心：modules/<业务>/{service, repository, errors}（由 @repo/di 装配）
   ↓
@repo/di      DI 门面：@Injectable/@Inject + AppContext 组合根 + 生命周期调度（InversifyJS 8 封装）
@repo/db      TypeORM 实体 + DataSource + 分页（pageWith / cursorPageWith）+ 迁移
@repo/shared  Zod schema（契约）+ dicts（错误码 / 字典）+ AppResponse（响应格式）
   ↑ 被 core / db / server / sdk / 前端共同依赖 —— 契约先行
@repo/sdk     ServerClient：全类型化业务 API 调用（前端 / 脚本使用）
apps/web      前台（Base UI + shadcn）
apps/admin    后台（Ant Design + @repo/aui）
```

**依赖方向不可逆**：`shared` 不依赖任何业务包；`di` 不依赖任何业务包；
`core` 不 import `apps/*`；`apps/server` 不写业务逻辑。
新增功能时按依赖方向自底向上落代码。

## 4. 一次请求的数据流

1. 前端调用 `ServerClient.xxx.create(payload)`（`@repo/sdk`）。
2. `apps/server/src/features/*.ts` 路由用 `jsonBody(CreateXxxSchema)` 做 **Zod 边界校验**。
3. 路由调 `runtime.get(XxxService)` 上的方法。
4. service（可 `@Transactional()`）调 repository 读写 TypeORM。
5. 业务错误抛 `AppError` 子类（自带数字 `code`），由 `lib/http.ts` 的 `errorHandler`
   经 `AppErrorCodes` 字典映射为 HTTP 状态码 + 中文文案；未知错误一律 5001 / 500。
6. 成功统一 `success(context, data)` → `{ code: 0, data }`。
