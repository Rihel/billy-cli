# 对象存储访问策略：前台可上传 + key 命名空间约束

> 触发问题（2026-09-17）：`/account`（web 前台个人中心）的头像上传**必然失败** ——
> `storage.controller.ts` 整个控制器挂 `AdminAuthGuard`，实测前台 user token 调
> `/storage/get-presigned-url` 返回 `{ code: 1005, message: 'Token 无效或已过期' }`。
> 目标：让前台用户能上传自己的文件，同时**不引入越权写入**。

## 1. 身份矩阵（本轮定稿）

| 路由 | 管理员 | 前台用户 | 无身份（`AUTH_ENABLED=false`） |
| --- | --- | --- | --- |
| `POST /storage/get-presigned-url` | key 原样 | **改写**为 `user/{userId}/{basename}` | key 原样 |
| `POST /storage/get-download-url` | key 原样 | **必须**在 `user/{userId}/` 前缀下，否则 403 | key 原样 |
| `POST /storage/get-temporary-credentials` | 允许 | **拒绝**（仍管理员专用） | 允许（用占位 session 名） |

要点：

1. **上传是「改写」而不是「校验」**：前端 `useStorage` 用 `md5 + 扩展名` 生成扁平 key
   （`apps/../use-storage.ts`），它不知道自己的 userId；而响应 `StoragePresignedUrlModel`
   已经带 `key`，且前端**用的是响应里的 key**（`key: presigned.key`）—— 所以服务端可以安全地
   改写并把最终 key 回给前端落库。
2. **下载是「校验」而不是「改写」**：下载必须命中已存在的对象，改写会指向不存在的 key，
   故只能拒绝越界的 key（403）。
3. **STS 不放开**：`getTemporaryCredentials` 走的是 `AssumeRole`（`providers/s3.ts`），
   返回的是**整桶权限**的临时凭证，与「前缀约束」不是一回事；发给 C 端用户等于把整个桶交出去。
   要放开必须先在 provider 侧支持按前缀限定 policy —— 本轮不做（列入演进）。
4. `AUTH_ENABLED=false`（自用 / 外部认证）时没有身份概念，行为与管理员一致（key 原样），
   与既有姿态保持一致；顺带修掉 `currentAdminId()` 在该模式下抛错导致 STS 500 的问题
   （改用可空的 `requestContext.get('adminId')`）。

## 2. key 规则（纯函数）

落点：`apps/server/src/modules/storage/storage-key.ts`（纯函数，无 IO，可单测）。

```ts
/** 前台用户的 key 命名空间前缀 */
export const userKeyPrefix = (userId: string) => `user/${userId}/`

/** 上传：管理员 / 无身份原样；用户强制改写进自己的前缀（只取最后一段，防目录穿越） */
resolveUploadKey({ key, userId }): string

/** 下载：管理员 / 无身份放行；用户必须落在自己的前缀内，否则抛 StorageKeyForbiddenError */
assertDownloadKey({ key, userId }): void
```

- 只取 `key` 的**最后一段**并过滤非法字符（`[A-Za-z0-9._-]` 之外一律清除），
  杜绝 `../../etc/passwd`、绝对路径、空 key 与「伪造别人的前缀」。
- 过滤后为空 → 抛 `StorageKeyInvalidError`（400）。
- 用户 key 一律不透明（md5 文件名），前缀让「谁的文件」在存储层可辨认，便于审计与清理。

## 3. 鉴权：任一身份

- `common/security/any-of-guards.ts`：纯编排助手 `anyOfGuards(guards, context)` ——
  依次尝试，任一通过即放行，全失败抛**最后一个**守卫的异常（错误语义与单身份模式一致）。
  `common/` 不 import 业务模块，故只依赖 `CanActivate` 这类框架类型。
- `modules/auth/any-auth.guard.ts`：`AnyAuthGuard`（注入 `UserAuthGuard` + `AdminAuthGuard`，
  调上面的助手）。放在认证模块（两个身份体系的共同归属），`AuthModule` 因此 import `AdminModule`
  （无环：AdminModule 不反向依赖 AuthModule）。
- **顺带去重**：`StreamAuthGuard` 的 `'both'` 分支改为复用 `AnyAuthGuard`，两处语义只有一份实现。
- `StorageModule` import `AuthModule` + `AdminModule`，控制器挂 `AnyAuthGuard`。

## 4. 验证

- 纯函数单测：`apps/server/test/storage-key.test.ts`（改写 / 穿越 / 空 key / 越界下载 / 管理员原样）。
- 真实链路实测：用户 token 上传 → 返回 key 带 `user/{id}/` 前缀且预签名 URL 可 PUT；
  用户 token 下载他人 key → 403；用户 token 调 STS → 403；管理员 token 三条路由行为不变。

## 5. 演进（本轮不做）

- STS 按前缀限定 policy（让 C 端也能用临时凭证直传大文件）。
- 对象生命周期与孤儿文件清理（用户换头像后旧对象仍留在桶里）。
