# 安全性（develop-backend-api 引用文件）

> 本文件是 `develop-backend-api` skill 的组成部分，由主 SKILL.md 引用。
> 加新路由、做资源操作（改 / 删他人数据）、涉及文件与敏感数据时必读。

- 鉴权三选（controller / 路由级，**显式决定、不默认裸奔**）：公开不加守卫；
  登录用户 `@UseGuards(UserAuthGuard)`；管理员 `@UseGuards(AdminAuthGuard)`
  （`apps/server/src/modules/auth/user-auth.guard.ts` / `apps/server/src/modules/admin/admin-auth.guard.ts`；
  双体系 / token / 守卫细节见 `implement-auth`）。
- 越权防护：
  - 水平越权：操作他人资源（改 / 删某 user 的数据）时，用
    `requestContext.get('userId' | 'adminId')`（`apps/server/src/common/request-context/request-context.ts`，
    AsyncLocalStorage）与资源归属比对，或只允许操作自己的 id；
  - 垂直越权：管理员接口必须 `@UseGuards(AdminAuthGuard)`，不能只靠前端隐藏入口。
- 输入安全：Zod 契约即白名单，不做「前端传什么存什么」；SQL 一律参数化；
  **文件 key 不要信任前端任意值**——现有 `/storage/get-presigned-url` 入参为 `{ key, access? }`，
  `key` 未限格式，若自建文件端点应校验扩展名白名单 / key 前缀（key 约定见 `object-storage`）。
- 敏感数据：响应模型经 `toXxx()` 剥离内部字段（`deletedAt` 等）；日志不记 token / 密码 /
  密钥 / 完整授权头；错误文案不带内部堆栈。
- 限流：登录 / 短信 / 上传等敏感端点加 `@UseGuards(RateLimitGuard)` + `@RateLimit({ scope })`
  （`apps/server/src/common/security/rate-limit.guard.ts`，参考 `apps/server/src/modules/auth/auth.controller.ts`），防爆破与滥用。

检查项：换别的用户 token 访问他人资源被拒？普通用户 token 打 admin 接口被拒？敏感字段没漏出？
