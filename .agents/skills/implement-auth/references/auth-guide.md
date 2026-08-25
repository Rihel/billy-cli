# 认证与权限详解（implement-auth 引用文件）

> 本文件是 `implement-auth` skill 的组成部分，由主 SKILL.md 引用。
> 实现 / 修改认证与权限时必读。设计决策与演进方向见
> `docs/design/auth-session.md`（服务端会话方案）。

## 1. 双体系心智模型（必须分清）

| | 前台用户 | 后台管理员 |
| --- | --- | --- |
| 实体 | `UserEntity`（`users` 表） | `AdminEntity`（`admins` 表） |
| 业务服务 | `AuthService` | `AdminService` / `UserService` |
| 接口前缀 | `/auth/*` | `/admin/*`、`/user/*` |
| 服务端中间件 | `makeRequireAuth`（注入 `userId`） | `makeRequireAdminAuth`（注入 `adminId`） |
| SDK 段 | `client.auth.*` | `client.admin.*` / `client.user.*` |
| 前端 | `apps/web`（login / register / forgot-password / reset-password） | `apps/admin`（login，独立体系） |
| 错误码段 | `1xxx` 认证（1000-1009） | `2xxx` 用户 + 管理员（2001-2006） |

**两者完全隔离**：管理员登录走 `client.admin.login`，用户登录走 `client.auth.login`，
token 里带类型标识，`verifyToken` 分别校验，混用必然失败。
（错误码分段权威定义见 `billy-dev-foundation/references/code-conventions.md` 第 3 条。）

## 2. 后端：签发与校验

- **签发**：登录成功后由 core 的 `AuthService` / `AdminService` 签发 token
  （`TokenSigner`，JWT，`JWT_SECRET` / `JWT_EXPIRES_IN` 配置，见
  `packages/core/src/infrastructure/token-signer.ts`）。响应模型**按体系区分**：
  用户登录 `AuthResultModel`（`auth.schema.ts`），管理员登录 `AdminAuthResultModel`
  （`admin.schema.ts`，`{ token, admin }`）。
- **服务端会话（Redis）**：签发 JWT 的同时由 `SessionStore`
  （`packages/core/src/infrastructure/session-store.ts`）把会话写入 Redis——
  key `auth:session:{sha256(token)}`（TTL 与 JWT 有效期一致）+ 索引
  `auth:index:{type}:{sub}`（Set，供批量踢人）。**每次请求校验 JWT 后必须查 Redis
  会话存在**，登出 / 禁用 / 删除会撤销会话，使已签发 token 立即失效
  （见 `AuthService.verifyToken` / `AdminService.verifyToken`）。
- **登出**：`/auth/logout`、`/admin/logout` **幂等**（不挂鉴权中间件，token 有效则
  撤销会话、无效也返回成功）——前端 `onUnauthorized` 调用不会形成 401 循环。
- **校验**：`apps/server/src/lib/authentication.ts` 的 `extractToken` 支持两种携带方式：
  `Authorization: Bearer <token>` 或 `access-token` cookie。中间件校验失败时返回
  `AppErrorCodes.Unauthorized`（无 token）或 `TokenInvalid`（校验失败），不抛异常进 errorHandler。
- **注入上下文**：校验通过后把身份写入请求上下文（`requestContext.set('userId' | 'adminId', id)`），
  业务层从 `requestContext` 取当前身份，不做参数透传。

## 3. 服务端中间件使用（新模块路由选型）

```ts
// apps/server/src/features/xxx.ts
const requireAuth = makeRequireAuth(runtime)           // 前台用户
const requireAdminAuth = makeRequireAdminAuth(runtime) // 后台管理员（参考 features/admin.ts）

routes.use('*', requireAuth)   // 整个路由组需要登录
```

- 整组受保护：`routes.use('*', requireXxx)`。
- 混合（部分公开）：不加全局中间件，公开 handler 直接放行，受保护 handler 内单独挂中间件
  （`routes.post('/x', requireAuth, jsonBody(Schema), handler)`）。
- **新增接口必须明确鉴权策略**，禁止默认裸奔（公开接口要在代码注释里说明原因）。

**当前路由鉴权一览**（新模块/改路由前先对照，别挂错体系）：

| 路由 | 鉴权 | 说明 |
| --- | --- | --- |
| `/auth/*` | register / login / forgot-password / reset-password 公开；get-me / update-info / change-password 用 `makeRequireAuth` | 前台用户自助 |
| `/admin/*` | login 公开；其余 `makeRequireAdminAuth` | 后台管理员 |
| `/user/*` | `makeRequireAdminAuth` | 管理员管理用户 |
| `/todo/*` | `makeRequireAdminAuth` | 后台功能（admin 页） |
| `/storage/*` | `makeRequireAdminAuth` | 上传/下载/STS（admin 页 ImageUpload） |

## 4. 前端：Server Actions + 双存储模型

参考 `apps/admin/src/actions/auth.actions.ts`、`apps/admin/src/lib/server-client.ts`、
`apps/web/src/actions/auth.actions.ts`。

token 采用**双存储**，各有分工：

1. **localStorage**（浏览器 JS 可读）：客户端 `getServerClient()` 用
   `LocalStorageCredentialsManager(TokenKey)` 存 token，供 SDK 发 `Bearer` 请求
   （见 `apps/admin/src/lib/server-client.ts` 的 `tokenManager`）。
2. **httpOnly cookie**（浏览器 JS 不可读）：Server Action 登录时 `cookies()` 写入，
   供 SSR 守卫（`main/layout.tsx`）与会话探测（`checkSessionAction`）读取。

要点：
- 登录 action：调 SDK 登录 → `jar.set(TokenKey, data.token, cookieOptions(7d))` 写 cookie；
  客户端登录页成功后 `saveToken(token)` 写 localStorage（web login 页即是此流程）。
- 登出：`jar.delete(TokenKey)` + 客户端 `tokenManager.clearCredentials()`。
- 错误封装：admin 用 `defineAction`（`@repo/aui/action`，返回 `{ ok, data } | { ok: false, error }`）；
  web 用本地 `wrapAction`（返回 `{ success, data | error }`）。
- 会话探测：登录页挂载时调 `checkSessionAction`（admin 已有），用 cookie token 调
  `getMe()` 验证有效性，失效则清 cookie——避免与 SSR 守卫互相弹回死循环。

## 5. 路由守卫（Next.js）

- **proxy 中间件**（`apps/admin/src/proxy.ts`；web 无 proxy）：按 `PublicPaths`
  判断公开页，非公开页无 cookie 时 `redirect(login)`。`matcher` 排除静态资源。
- **SSR 守卫**（`apps/admin/src/app/main/layout.tsx`）：`force-dynamic` + `cookies()` 取
  token → `createServerClient(token).admin.getMe()`，失败 `redirect(login?reason=expired)`；
  成功把管理员信息预取进 `AuthStoreProvider`（Zustand）。
- 修改 `PublicPaths` / `Pages` 在 `apps/*/src/lib/constants.ts`（admin 有 `PublicPaths`，web 无）。

## 6. 找回 / 重置 / 修改密码

仓库已实现完整流程（用户侧 `AuthService`，管理员侧 `AdminService`），新增类似能力前先
「实现查找顺序」复用：

- **忘记密码**：`ForgotPasswordDto` → 生成 `resetPasswordToken` + 过期时间（存实体
  `reset_password_token` / `reset_password_token_expiry`）→ 发送重置链接。
  web 前台页面：`apps/web/src/app/auth/forgot-password`（成功自动跳到
  `/auth/reset-password?token=xxx`）、`apps/web/src/app/auth/reset-password`。
- **重置密码**：`ResetPasswordDto`（token + 新密码）→ 校验令牌 → 改密码。
- **修改密码**：`ChangePasswordDto`（旧密码 + 新密码）→ 校验旧密码 → 改密码。
- **登录禁用校验**：用户/管理员登录时校验 `status`，禁用（`disabled`）账号登录被拒：
  用户抛 `UserDisabledError`（2007），管理员抛 `AdminDisabledError`（2004）。
- **错误码**：`1xxx` 认证、`2xxx` 用户 + 管理员（`UserDisabled` 2007 / `AdminDisabled` 2004）。
- 相关错误码：`InvalidResetToken`(1003) / `ExpiredResetToken`(1004) /
  `InvalidOldPassword`(1008) / `PasswordUnchanged`(1009)。
- 相关 schema：`packages/shared/src/schema/auth.schema.ts`（ForgotPassword / ResetPassword /
  ChangePassword）、`admin.schema.ts`（ResetAdminPassword）。
- 密码规则 `z.string().min(6)`；哈希用 `PasswordHasher` 基础设施，禁止明文。

## 7. 常见改造点（改前先按「实现查找顺序」确认）

- 新增登录方式（验证码 / 第三方）：先看 `@repo/api-client` 的策略（OAuth2Strategy 等）与
  `core` 基础设施是否覆盖，再决定自研。
- 令牌过期 / 刷新：当前体系为单 token + `JWT_EXPIRES_IN`（默认 7d），无 refresh token；
  需要时按 `docs/sdk-refactor.md` 的教训评估，避免过度设计。
