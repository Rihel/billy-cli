---
name: implement-auth
description: 在 Billy 工程中实现或修改认证与权限：登录 / 注册 / 找回密码、JWT 签发与校验、UserAuthGuard / AdminAuthGuard 守卫、前端 Server Actions + token 双存储（localStorage + httpOnly cookie）、proxy 与 SSR 路由守卫、用户 / 管理员双体系隔离。触发词：认证、鉴权、登录、注册、登出、找回密码、重置密码、token、cookie、权限、守卫、UserAuthGuard、JWT。
---

# 认证与权限

前置：先加载必读 skill `billy-dev-foundation`。涉及数据结构（如新增令牌字段）时加载
`define-data-structure`。

## 核心要点

- **双体系隔离**：前台用户（`AuthService` / `/auth/*` / `UserAuthGuard`）与后台管理员
  （`AdminService` / `/admin/*` / `AdminAuthGuard`）严格分离，token 带类型标识分别校验。
- **错误码段**：`1xxx` 认证、`2xxx` 用户 + 管理员（与 code-conventions 一致）。
- **token 双存储**：localStorage（SDK Bearer 请求）+ httpOnly cookie（SSR 守卫 / 会话探测），
  登录时两者都要写。
- **找回 / 重置 / 修改密码**已实现（ForgotPassword / ResetPassword / ChangePassword），
  先复用勿自研。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/auth-guide.md](./references/auth-guide.md) | 双体系表、签发校验、守卫选型、Server Actions + 双存储、路由守卫、找回密码流程、改造点 | 实现 / 修改认证时（必读） |

## 完成检查清单

- [ ] 鉴权策略明确：公开 / `@UseGuards(UserAuthGuard)` / `@UseGuards(AdminAuthGuard)`，未默认裸奔
- [ ] 错误走 `AppError` + 错误码（1xxx 认证 / 2xxx 用户+管理员），守卫复用 `Unauthorized` / `TokenInvalid`
- [ ] token 双存储一致：localStorage（Bearer）+ httpOnly cookie（SSR 守卫），登出时两者都清
- [ ] 新页面已纳入 proxy 守卫与 SSR 鉴权（或确认公开）
- [ ] 用户与管理员体系未混用（接口、实体、token 校验严格分离）
- [ ] 密码不落明文，规则与 shared schema 一致（`z.string().min(6)`）
