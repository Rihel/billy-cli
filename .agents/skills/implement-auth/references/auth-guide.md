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
| 服务端守卫 | `UserAuthGuard`（写入 `userId`） | `AdminAuthGuard`（写入 `adminId`） |
| SDK 段 | `client.auth.*` | `client.admin.*` / `client.user.*` |
| 前端 | `apps/web`（login / register / forgot-password / reset-password） | `apps/admin`（login，独立体系） |
| 错误码段 | `1xxx` 认证（1000-1009） | `2xxx` 用户 + 管理员（2001-2007） |

**两者完全隔离**：管理员登录走 `client.admin.login`，用户登录走 `client.auth.login`，
token 里带类型标识，`verifyToken` 分别校验，混用必然失败。
（错误码分段权威定义见 `billy-dev-foundation/references/code-conventions.md` 第 3 条。）

## 2. 后端：签发与校验

- **签发**：登录成功后由 `AuthService` / `AdminService` 签发 token
  （`TokenSigner`，JWT，`JWT_SECRET` / `JWT_EXPIRES_IN` 配置，见
  `packages/kits/src/jwt/token-signer.ts`）。**必须带 `jti`**：jsonwebtoken 只自动补秒级
  `iat`/`exp`，同一 `sub` 在同一秒内登录两次会签出**逐字节相同**的 token，而会话以
  `sha256(token)` 为主键 —— 会直接导致「两台设备合并成一条会话」（UA 互相覆盖、
  下线一台等于下线两台），故 `sign()` 里显式 `jwtid`。响应模型**按体系区分**：
  用户登录 `AuthResultModel`（`auth.schema.ts`），管理员登录 `AdminAuthResultModel`
  （`admin.schema.ts`，`{ token, admin }`）。
- **服务端会话（Redis）**：签发 JWT 的同时由 `SessionStore`
  （`packages/kits/src/session/session-store.ts`）把会话写入 Redis——
  key `auth:session:{sha256(token)}`（TTL 与 JWT 有效期一致，负载含 `sessionId` /
  `createdAt` / `lastSeenAt` / `ip` / `userAgent`）+ 索引 `auth:index:{type}:{sub}`
  （Set，供批量踢人）+ 反查 `auth:sid:{type}:{sub}:{sessionId}`（单设备下线的 O(1) 定位）。
  **每次请求校验 JWT 后必须查 Redis 会话存在**，登出 / 禁用 / 删除会撤销会话，
  使已签发 token 立即失效（见 `AuthService.verifyToken` / `AdminService.verifyToken`）。
  登录时通过 `currentSessionMeta()`（`common/request-context`）把 IP / UA 从 ALS 写进会话。
- **登录设备（会话管理）**：`modules/session` 提供 `POST /session/list`（含 `current` 标记）与
  `POST /session/remove`（按 `sessionId` 下线，**幂等**）；鉴权用 `AnyAuthGuard`（任一身份），
  作用域锁定当前身份（`type` + `sub`），换别人的 `sessionId` 命中不了。
  前端入口：web `/account/sessions`、admin 个人中心「登录设备」区块。
  设计（key 设计、旧会话兼容、索引修剪）见 `docs/design/session-management.md`。
- **登出**：`/auth/logout`、`/admin/logout` **幂等**（不挂鉴权守卫，token 有效则
  撤销会话、无效也返回成功）——前端 `onUnauthorized` 调用不会形成 401 循环。
- **校验**：`apps/server/src/common/security/authentication.ts` 的 `extractToken` 支持两种携带方式：
  `Authorization: Bearer <token>` 或 `access-token` cookie。守卫校验失败时抛边界错误
  `AppErrorCodes.Unauthorized`（无 token）或 `TokenInvalid`（校验失败），
  由全局 `AppExceptionFilter` 统一映射。
- **注入上下文**：校验通过后守卫把身份写入 `apps/server/src/common/request-context/request-context.ts` 的
  AsyncLocalStorage（`requestContext.set('userId' | 'adminId', id)`），
  业务层从 `requestContext` 取当前身份，不做参数透传。

## 3. 服务端守卫使用（新模块 controller 选型）

```ts
// apps/server/src/modules/xxx/xxx.controller.ts（参考 modules/user/user.controller.ts）
@Controller('xxx')
@UseGuards(UserAuthGuard)          // 前台用户
// @UseGuards(AdminAuthGuard)      // 后台管理员（参考 modules/admin/admin.controller.ts）
// @UseGuards(AnyAuthGuard)        // 任一身份（前端用户或管理员）；见 modules/storage、modules/session
export class XxxController {}
```

- 整个 controller 受保护：类上挂 `@UseGuards(UserAuthGuard)` / `@UseGuards(AdminAuthGuard)`。
- 混合（部分公开）：类上不加守卫，公开 handler 直接放行，受保护 handler 上单独挂守卫
  （`@Post('x') @UseGuards(UserAuthGuard)` + handler）。
- **新增接口必须明确鉴权策略**，禁止默认裸奔（公开接口要在代码注释里说明原因）。

**当前路由鉴权一览**（新模块/改路由前先对照，别挂错体系）：

| 路由 | 鉴权 | 说明 |
| --- | --- | --- |
| `/auth/*` | register / login / forgot-password / reset-password 公开；get-me / update-info / change-password 用 `@UseGuards(UserAuthGuard)` | 前台用户自助 |
| `/admin/*` | login / logout 公开；其余 `@UseGuards(AdminAuthGuard)` | 后台管理员 |
| `/user/*` | `@UseGuards(AdminAuthGuard)` | 管理员管理用户 |
| `/storage/*` | `@UseGuards(AdminAuthGuard)` | 上传/下载/STS（admin 页 ImageUpload） |

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
- 错误封装：admin 用 `defineAction`（`@repo/ui/action`，返回 `{ ok, data } | { ok: false, error }`）；
  web 用本地 `wrapAction`（返回 `{ success, data | error }`）。
- 会话探测：登录页挂载时调 `checkSessionAction`（admin 已有），用 cookie token 调
  `getMe()` 验证有效性，失效则清 cookie——避免与 SSR 守卫互相弹回死循环。

## 5. 路由守卫（Next.js）

- **admin proxy 中间件**（`apps/admin/src/proxy.ts`）：按 `PublicPaths` 判断公开页，
  非公开页无 cookie 时 `redirect(login)`。`matcher` 排除静态资源。
- **SSR 守卫**（`apps/admin/src/app/main/layout.tsx`）：`force-dynamic` + `cookies()` 取
  token → `createServerClient(token).admin.getMe()`，失败 `redirect(login?reason=expired)`；
  成功把管理员信息预取进 `AuthStoreProvider`（Zustand）。
- **SSR 会话探测（web 前台页）**：`apps/web/src/lib/auth-session.ts` 的
  `getWebAuthState()`（React `cache()` 包裹，同一请求只请求后端一次）读 cookie →
  `auth.getMe()`，把 `authEnabled` / `user` 传给页面各区块（首页即 Header / Hero /
  CtaSection / Footer）；**账号入口（登录 / 注册 / 忘记密码 / 重置密码）一律由它决定是否渲染**，
  已登录时全部不渲染，避免出现「登录后首页还挂着登录按钮」。会话失效返回 `null`
  （前台不强制登录，不跳转）。公开页不强制登录。
- **web 受保护页两层守卫**（2026-09-17 起，参考 `/account`）：
  ① `apps/web/src/proxy.ts` 只对 `config.matcher` 里的受保护前缀生效，查 `access-token` cookie
  是否存在，无 cookie 直接 **307** 到登录页并带 `?next=<原路径>`（**必须走中间件**：嵌套 layout
  的 `redirect()` 在流式响应开始后只能得到 200 + RSC 跳转意图，禁用 JS 就不跳）；
  ② 该区 `layout.tsx` 调 `getWebAuthState()` 判定「cookie 在但服务端会话已失效」→ 跳登录页，
  `AUTH_ENABLED=false` → 回首页（中间件不请求后端，避免每个请求多一次往返）。
- **`?next=` 回跳必须过滤**：`resolveNextPath`（`apps/web/src/lib/redirect.ts`）只接受站内相对路径
  （拒绝 `https://evil.com` 与 `//evil.com`），登录 / 注册成功后跳它，注册链接也带上 `next`。
- 修改 `PublicPaths` / `Pages` 在 `apps/*/src/lib/constants.ts`（admin 有 `PublicPaths`，web 用
  `Pages` + `proxy.ts` 的 `matcher`）。

## 6. 找回 / 重置 / 修改密码

仓库已实现完整流程（用户侧 `AuthService`，管理员侧 `AdminService`），新增类似能力前先
「实现查找顺序」复用：

- **忘记密码**：`ForgotPasswordDto` → 生成明文令牌 → **库里只存 `sha256(token)`** + 过期时间
  （实体 `reset_password_token` / `reset_password_token_expiry`）→ 经 `Notifier` 邮件通道
  把重置链接发到用户邮箱（`WEB_URL` 配置拼绝对地址）。**API 响应不含令牌**；用户不存在时
  与成功响应一致（不泄露账号是否存在）。邮件未配置时本地开发会把链接写 warn 日志，生产不写。
  web 前台页面：`apps/web/src/app/auth/forgot-password`（提交后只显示"已受理"）。
- **重置密码**：`ResetPasswordDto`（token + 新密码）→ 先 `sha256(token)` 再查用户 → 校验过期 →
  改密码 → **撤销该用户全部会话**（`SessionStore.revokeAll('user', id)`，旧 token 立即失效）。
  web 前台页面：`apps/web/src/app/auth/reset-password`。
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

- 新增登录方式（验证码 / 第三方）：先看 `@repo/http-client` 的策略（OAuth2Strategy 等）与
  `kits` 基础设施是否覆盖，再决定自研。
- 令牌过期 / 刷新：当前体系为单 token + `JWT_EXPIRES_IN`（默认 7d），无 refresh token；
  需要时按 `docs/sdk-refactor.md` 的教训评估，避免过度设计。
