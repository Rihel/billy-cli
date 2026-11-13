# 认证鉴权设计改进：服务端会话（Redis）

> 目标：修复认证鉴权体系的两个系统性缺陷——①路由鉴权挂错体系（管理接口误用前台用户鉴权）；
> ②JWT 纯无状态，禁用 / 删除 / 登出对已签发 token 不生效。
> 方案：**服务端会话存 Redis，每次请求校验 JWT 后查会话**，登出 / 禁用 / 删除即时撤销。
>
> 2026-09-17 更新：会话负载扩展为「主体 + `sessionId` + 时间 + IP / UA」，并新增
> **登录设备列表 + 单设备下线**（`modules/session`，用户与管理员共用）；同时给 JWT 补
> **`jti`** —— 原先同一秒内重复登录会签出逐字节相同的 token，而会话以 `sha256(token)`
> 为主键，会把两台设备合并成一条。详见 `docs/design/session-management.md`
> （本文第 3 节的 key 设计以该文为准）。
>
> 2026-11-13 核对（现状口径）：
> - 存储实现 `packages/kits/src/session/session-store.ts`（`SessionStore`），由
>   `SessionStoreModule` 装配；依赖 `JwtConfig` + `RedisStore` + `IdGeneration`
>   （`jti` 与 `sessionId` 都由它生成）；
> - token 提取在 `apps/server/src/common/security/authentication.ts` 的 `extractToken`，
>   按身份体系分别读 `admin-access-token`（管理员）/ `access-token`（前台）两种 cookie，
>   或 `Authorization: Bearer`；
> - 三把 key 与「登录设备」接口见 `session-management.md`；双身份入口用 `AnyAuthGuard`
>   （`modules/auth/any-auth.guard.ts`）。

## 1. 背景与问题（审计结论）

对认证鉴权全链路审计后发现：

| 级别 | 问题 | 实证 |
| --- | --- | --- |
| P0 | `verifyToken` 只验 JWT 签名、不查实体与状态 | 禁用用户后，其旧 token 调 `/auth/get-me` 仍返回 200（status 已是 disabled） |
| P1 | 路由鉴权靠人工挂载，无机制保障 | `/user`、`/storage` 两处管理接口都误挂 `makeRequireAuth`（前台用户），admin token 调用必 401 |
| P1 | 用户 token 无类型标识，校验不对称 | 用户 token 只签 `{ sub }`，admin 签 `{ sub, type: 'admin' }`；用户侧用排除法（`type !== 'admin'` 即放行） |
| P2 | 密码重置 token 明文存库、forgot 响应返回 token | 安全弱点（本次不处理，见演进） |
| P2 | web 前台鉴权薄弱（无守卫 / 无登出） | 本次补 logoutAction，页面入口待做 |
| P3 | 无 RBAC 权限模型 | 二元体系够用，演进方向见 §6 |

**P0 是核心**：禁用 / 删除形同虚设——只拦「重新登录」，不拦「已有会话」。

## 2. 方案选型（服务端会话 vs 查库）

| 方案 | 即时失效 | 每请求开销 | 主动登出 | 结论 |
| --- | --- | --- | --- | --- |
| JWT 纯无状态（现状） | ✗ | 无 | ✗ | 淘汰（P0 缺陷） |
| `verifyToken` 查库校验实体状态 | ✓ | DB 查询 | ✗（需额外黑名单） | 可行，但打 DB 且登出需额外机制 |
| **服务端会话存 Redis** | ✓ | Redis 读（快） | ✓（撤销会话） | **采纳** |

选型依据：工程已有 `RedisStore` 统一入口（`setJson` / `del` / raw 客户端），复用不重复造轮子；
Redis 会话支持**主动失效**（登出 / 禁用 / 删除即踢下线），且天然支持多设备会话管理。

## 3. 能力放置位置

| 项 | 决定 |
| --- | --- |
| 能力性质 | 横切基础设施（认证会话统一入口） |
| 位置 | `packages/kits/src/session/session-store.ts`（`SessionStore`） |
| 注册 | `SessionStoreModule` 装配（`@Global()`，复用 `JwtModule` 的 `JwtConfig`、`RedisModule` 的 `RedisStore` 与 `IdGenerationModule` 的 `IdGeneration`；业务模块直接 `@Inject(SessionStore)`）；`session/index.ts` 聚合后由 `packages/kits/src/index.ts` 导出 |
| 依赖 | 复用 `RedisStore`（ioredis）+ `AppConfig`（`jwt.expiresIn` 解析 TTL），无新增依赖 |
| 错误 | `RedisStoreError`（`AppErrorCodes.Internal`） |

接入点：`AuthService` / `AdminService`（签发 + 校验 + 登出）、`UserService` / `AdminService`
（禁用 / 删除时批量撤销）、`modules/auth/user-auth.guard.ts`（`UserAuthGuard`）与
`modules/admin/admin-auth.guard.ts`（`AdminAuthGuard`）在请求进入时校验身份（身份写入
`common/request-context/` 的 AsyncLocalStorage，token 提取在 `common/security/authentication.ts`），
logout 路由在 `modules/auth/auth.controller.ts` 与 `modules/admin/admin.controller.ts`
（`@Controller` + `@Post` + `@HttpCode(200)` + `@Body({ schema })`）；
需要「任一身份」的入口用 `modules/auth/any-auth.guard.ts` 的 `AnyAuthGuard`
（会话管理 `/session/*`、对象存储 `/storage/*`、SSE `/sse/subscribe` 都用它）。

## 4. 关键设计

### 4.1 会话 key 与索引

```
auth:session:{sha256(token)}        → JSON 负载（sub / type / sessionId / 时间 / ip / userAgent），TTL = jwt.expiresIn（默认 7d）
auth:sid:{type}:{sub}:{sessionId}   → sha（单设备下线的 O(1) 反查）
auth:index:{type}:{sub}             → Set（该主体全部会话 sha，供批量踢人与列表遍历）
```

- token 以 sha256 摘要作 key：避免超长 key、Redis 中不落明文 token。
- 索引用于「禁用 / 删除实体」时 O(1) 拿到全部会话一次性撤销。

### 4.2 SessionStore 接口

| 方法 | 语义 |
| --- | --- |
| `create(token, { sub, type }, meta?)` | 登录 / 注册成功：写会话 + `auth:sid` 反查 + SADD 索引（`meta` 带 ip / userAgent） |
| `verify(token)` | 每次请求：读会话，不存在返回 null；顺带节流（60s）写回 `lastSeenAt` |
| `revoke(token)` | 登出：删会话 + 删 sid 反查 + SREM 索引（幂等，会话不存在静默成功） |
| `revokeAll(type, sub)` | 禁用 / 删除：SMEMBERS 索引 → 逐个删会话 → 删索引 |
| `list(type, sub, currentToken?)` | 登录设备列表：返回 `{ entries, currentSessionId }`，顺带修剪过期成员、补写旧会话 |
| `revokeById(type, sub, sessionId)` | 单设备下线（幂等，作用域固定为当前身份） |

### 4.3 校验链路（verifyToken）

```
JWT 验签 → 体系校验（用户拒 type=admin / 管理员要求 type=admin）
        → SessionStore.verify(token) 必须存在且 type/sub 与 JWT 一致，否则 TokenInvalid
```

- 会话以 **`sha256(完整 token)`** 为主键，所以 token 里必须有 `jti`（`TokenSigner.sign` 用
  `IdGeneration.next(16)` 作 `jwtid`）：否则同一主体同一秒内两次登录会签出逐字节相同的 token，
  两台设备被合并成一条会话；
- 会话负载里的 `sessionId` 是**另一个**随机值（对外暴露、用于单设备下线），与 token 无推导关系。

### 4.4 幂等登出（避免 401 死循环）

- `/auth/logout`、`/admin/logout` **不挂鉴权中间件**：token 有效则撤销会话，无效也返回成功。
- 前端 `onUnauthorized`（401 时触发）会调用 logoutAction → 服务端登出；若 logout 挂了鉴权，
  会话已失效时再次 401 → 无限循环。幂等设计使该链路安全。

### 4.5 即时失效语义

| 动作 | 失效范围 |
| --- | --- |
| 登出（`/auth/logout`、`/admin/logout`） | 当前 token |
| 禁用用户 / 管理员（`update(status=disabled)`） | 该实体全部会话（立即踢下线） |
| 删除用户 / 管理员（`remove`） | 该实体全部会话 |

## 5. 验证（实证）

| 场景 | 结果 |
| --- | --- |
| 禁用用户后，旧 token 调 `/auth/get-me` | **401**（修复前 200） |
| 登出后，旧 token 调 `/auth/get-me` | **401** |
| 禁用 admin 后，其旧 token 调 `/admin/get-me` | **401** |
| 恢复启用 → 重新登录 | 200 |
| admin token 调 `/auth/*` / 用户 token 调 `/user/*` | 401（双体系隔离完好） |
| admin token 调 `/user/*`、`/storage/*` | 200 |

**一次性影响**：改造前签发的 token 无 Redis 会话，全部失效需重新登录（可接受）。

## 6. 演进方向（本次不实现）

- **token 版本号**：实体加 `tokenVersion` 列，签发时写入 JWT，verify 时比对——免 Redis 读、
  支持主动失效，代价是实体 + 迁移；会话方案已满足当前需求，此作为高并发优化备选。
- **密码重置 token 哈希存储**：`resetPasswordToken` 应存哈希（如 sha256），杜绝 DB 泄露即用；
  forgot 响应返回 token 仅限开发环境，生产应邮件投递。
- **RBAC**：当前「用户 / 管理员」二元足够；引入角色需先定义权限点与中间件，再扩 `SessionStore`
  会话内容（如 `roles` 字段）——会话方案已为此预留（value 是 JSON，可扩展）。
