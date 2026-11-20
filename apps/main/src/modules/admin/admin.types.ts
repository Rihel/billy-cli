import type { AdminTypeValue } from '@repo/shared'

/**
 * 调用方身份（由 HTTP 边界传入）。
 *
 * `undefined` 表示**系统 / 脚本调用**（没有请求上下文，例如 `pnpm seed:admin` 与启动期种子），
 * 按特权处理；有值时普通管理员一律不能创建 / 提升超管。
 */
export interface AdminActor {
  adminType: AdminTypeValue
}

/** 管理员 token 校验结果：类型来自服务端会话，守卫据此写入请求上下文 */
export interface VerifiedAdminToken {
  adminId: string
  adminType: AdminTypeValue
}
