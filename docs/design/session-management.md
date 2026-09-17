# 会话管理：登录设备列表 + 单设备下线

> 目标：后端 Redis 会话已能「撤销全部会话」（改密码 / 禁用 / 删除即踢下线），但用户看不到
> **自己有哪些设备登录着**，也无法只踢掉某一台。本轮补齐「登录设备列表 + 单设备下线」，
> 前台（web `/account`）与后台（admin 个人中心）共用同一套接口。

## 1. 现状与缺口

| 项 | 现状 |
| --- | --- |
| 会话存储 | `kits/session/session-store.ts`：`auth:session:{sha256(token)}` → `{ sub, type }`，TTL 与 JWT 一致 |
| 主体索引 | `auth:index:{type}:{sub}` → Set&lt;sha&gt;，供「批量踢人」（改密码 / 禁用 / 删除） |
| 缺口 1 | **无元数据**：不知道会话何时创建、来自哪个 IP / 浏览器，列表只能显示一串哈希 |
| 缺口 2 | **无法单设备下线**：只有 `revoke(token)`（自己的 token）与 `revokeAll`（全部） |
| 缺口 3 | **索引会残留**：会话按 TTL 自然过期时，`auth:index` 里的成员不会被移除，且索引自身无 TTL |
| 缺口 4 | 前端没有入口：既无前台页面，也无后台界面 |

## 2. 方案

### 2.1 会话负载升级（兼容旧会话）

```ts
interface StoredSession {
  sub: string            // 实体 id
  type: 'user' | 'admin'
  sessionId: string      // 对外暴露的会话标识（随机，不可由 token 推导）
  createdAt: number
  lastSeenAt: number
  expiresAt: number      // 用于「续期时按剩余 TTL 写回」，避免把会话寿命越刷越长
  ip: string | null
  userAgent: string | null
}
```

三把 key（`redis.keyPrefix` 由 `RedisStore` 统一追加）：

| key | 值 | 用途 |
| --- | --- | --- |
| `auth:session:{sha256(token)}` | 上面的 JSON | 校验 + 展示 |
| `auth:sid:{type}:{sub}:{sessionId}` | sha | **单设备下线**的反查（O(1)，不必遍历） |
| `auth:index:{type}:{sub}` | Set&lt;sha&gt; | 批量踢人（既有）+ 列表遍历 |

- **不暴露 token 派生值**：对外只用随机的 `sessionId`；sha256(token) 虽然是单向的，但它是
  会话的存储主键，不该出现在响应里（`sessionId` 泄露也无法用来认证）。
- **旧会话兼容**：升级前登记的会话没有 `sessionId` / 元数据。`list()` 遇到这类条目**就地补写**
  （生成 sessionId、补 `createdAt = lastSeenAt = 现在`、写反查 key，TTL 用剩余寿命），
  避免出现“列不出来又删不掉”的僵尸条目；它们本来就快随 JWT 过期。
- **索引修剪与 TTL**：`list()` 会剔除 session key 已过期（`getJson` 返回 null）的索引成员；
  `create()` 给索引设置与会话相同的 TTL（每次登录刷新）—— 二者同时到期，不会出现「索引比会话长寿」。
- **`lastSeenAt` 节流**：`verify()` 在每个请求都会跑，因此只有当 `lastSeenAt` 落后超过 60s 才写回，
  且用剩余 TTL 写（不续命）。代价是「最后活跃」精度为分钟级 —— 对设备列表足够。

### 2.2 接口（双身份，一套实现）

| 路由 | 说明 |
| --- | --- |
| `POST /session/list` | 列出**当前身份**（用户或管理员）的全部会话，含 `current` 标记 |
| `POST /session/remove` | 按 `sessionId` 下线某台设备（**幂等**：已失效也返回成功） |

- 鉴权：`AnyAuthGuard`（任一身份，复用上一轮为存储引入的守卫）。
- 身份分域：`requestContext.get('adminId')` 优先，其次 `userId`；`AUTH_ENABLED=false`
  （无用户体系）时**返回空列表 / 幂等成功**，不报错 —— 该模式下本来就没有会话概念。
- 「当前会话」判定：用请求自带 token 算 sha 与会话条目比对，标 `current: true`。
  （JWT 里没有 sessionId，也不打算为此改 token 结构。）
- 放在独立 `modules/session`：用户会话来自身份、管理员会话来自身份，业务逻辑完全一样，
  在两处各写一遍控制器属于重复劳动；`SessionStore` 本身就是数据访问门面，故本模块**只有
  controller + service，没有 repository**。

### 2.3 契约与客户端

- `packages/shared/src/schema/session.schema.ts`：`SessionEntrySchema`（sessionId / createdAt /
  lastSeenAt / ip / userAgent / current）、`SessionListSchema`、`RemoveSessionSchema`。
- SDK：`client.session.list()` / `client.session.remove({ sessionId })`。
- UA 展示：`packages/shared/src/utils/user-agent.utils.ts` 的纯函数 `parseUserAgent(ua)` →
  `{ browser, os, device }`（不引第三方库；识别 Chrome / Edge / Firefox / Safari / 微信 / 常见爬虫，
  其余回落「未知」）。**两个前端共用它解析，各自渲染**（后台 hairline 列表、前台卡片），
  不为统一视觉而强做一个跨端组件。

### 2.4 前端入口

| 端 | 位置 | 内容 |
| --- | --- | --- |
| web | `/account/sessions`（account 区新增导航：资料 / 登录设备） | 卡片列表：设备（UA 解析）· IP · 登录时间 · 最后活跃；「本机」标签；非本机可「下线」 |
| admin | `/main/user-center` 新增「登录设备」区块 | 同数据源的 hairline 列表 + 下线按钮 |

- 下线后 `invalidateQueries` 刷新列表；**本机条目不给下线按钮**（要退出请用登出），
  避免用户把自己踢掉却以为是「退出登录」。
- 被下线设备的行为：它的 token 在下一次请求时 `verify()` 返回 null → 401 → 前端既有的
  `onUnauthorized` 清凭证并跳登录页（无需额外机制）。

## 3. 验证

- kits 单测：`create` 写入三把 key + 索引 TTL；`verify` 节流写回且不续命；`list` 排序 / current
  标记 / 剔除过期成员 / 升级旧会话；`revokeById` 幂等且清 sid 与索引。
- 真实链路实测：同一用户两次登录（不同 UA）→ `/session/list` 返回 2 条且 current 正确 →
  用 A 下线 B → B 的 token 立即 401（`/auth/get-me`）→ A 仍可用；管理员侧同链路。

## 4. 演进（本轮不做）

- 会话数量上限（防单账号无限设备）与「下线全部其他设备」一键操作。
- 异地 / 新设备登录提醒（接通知模块）。
- 会话审计（谁在何时下线了哪台设备）。
