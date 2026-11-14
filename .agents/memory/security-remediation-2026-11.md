# 安全整改（2026-11-14）：找回密码 / 桶私有 / STS / 唯一索引 / 锁与工具面

**查证优先级：抽核** —— 都是「默认安全口径」，动这些链路前先跑下面「核对」里的命令。

## 结论

- **找回密码**：`forgotPassword` 生成明文令牌后只落 `sha256(token)`，经 `Notifier` 邮件通道
  投递重置链接（`WEB_URL` 拼绝对地址）；API 响应仅 `{ success: true }`，用户不存在时同样返回成功。
  `resetPassword` 先哈希再查用户、成功后 `revokeAll('user', id)` 踢掉全部会话；单测见
  `test/auth-reset-password.test.ts`。
- **对象存储默认私有**：`providers/s3.ts` 的 `ensurePrivateBucket`（`initial()` 调用）建桶 +
  主动删除历史公开读桶策略 + CORS 放行 GET/HEAD/PUT；下载统一走 `getDownloadUrl` 预签名。
  前端 key → URL 用 `useStorageUrl` / `StorageClientProvider.getViewUrl`（异步），
  `formatStorageUrl` 只对绝对 URL 稳定（别再拿 key 拼公开地址）。
- **STS**：`/storage/get-temporary-credentials` 只认 `adminId`；`AUTH_ENABLED=false`（无身份）
  也拒绝 —— 避免空鉴权部署在公网时匿名拿桶级凭证。
- **邮箱唯一**：`users` / `admins` 的 `uk_*_email` 改**部分唯一索引** `WHERE deleted_at IS NULL`
  （迁移 `1794630000000-PartialEmailUnique`）。原来的 `UNIQUE(email, deleted_at)` 在 PG 下挡不住
  多个活用户同邮箱（NULL 互不相等）。
- **RedisLockService**：`unlock` 只在本地记录 token 匹配时停看门狗/删记录（避免误杀同进程新持有者）；
  新增 `tryLock`（抢不到返回 null，不排队）。
- **Monitor 评估锁**：改用 `RedisLockService.tryLock(lockKey, 30)` + 看门狗续租，不再 30s 裸 TTL。
- **工具面**：`resolveTools` 没有 caller 时只放行 `scope='all'`（`publicKeys`）；
  `buildRuntimeContext` 用 `authorizedChildToolbox(parentTools, caller)` 给子 agent 按身份过滤。
- **ToolResultStore**：条数 200 + 字节 32MB 双上限，FIFO 淘汰。

## 核对

```bash
grep -n "hashResetToken\|revokeAll('user'" apps/server/src/modules/auth/auth.service.ts
grep -n "ensurePrivateBucket\|DeleteBucketPolicy" packages/kits/src/storage/providers/s3.ts
grep -n "uk_user_email" apps/server/src/database/entities/user-entity.ts
grep -n "tryLock\|locker?.value === value" packages/kits/src/redis/redis-lock.service.ts
grep -n "publicKeys\|authorizedChildToolbox" apps/server/src/modules/ai/core/tools/tool.registry.ts apps/server/src/modules/ai/ai.module.ts
pnpm --filter @app/server test test/auth-reset-password.test.ts test/storage.controller.test.ts
```

## 失效信号

- 找回密码接口又出现响应回 token / 明文入库 / 不撤销会话；
- 桶策略回到 public-read，或 `formatStorageUrl` 重新被用于对象 key；
- STS 对无身份重新放行；
- 实体唯一约束改回 `(email, deleted_at)`；
- `unlock` 的 finally 又无条件 `stopWatchDog`；子 agent 工具面又变回注册机全量。
