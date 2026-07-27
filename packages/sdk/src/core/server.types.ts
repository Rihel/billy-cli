import type { z } from 'zod'
import {
  UserModel,
  AuthResultDto,
  TodoModel,
  TodoCursorDto,
  StoragePresignedUrlModel,
  StorageStsModel,
} from '@repo/shared'

/** 从 Zod schema 推断的安全用户类型 */
export type SafeUser = z.infer<typeof UserModel>

/** 登录/注册结果 */
export type AuthResult = z.infer<typeof AuthResultDto>

/** 通用成功响应 */
export interface SuccessResult {
  success: true
  token?: string
}

/** Todo 条目 */
export type TodoItem = z.infer<typeof TodoModel>

/** 游标 */
export type TodoCursor = z.infer<typeof TodoCursorDto>

/** 游标分页响应 */
export interface TodoCursorPage {
  items: TodoItem[]
  nextCursor: TodoCursor | null
}

/** 通用分页响应 */
export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  size: number
}

/** 预签名上传 URL */
export type StoragePresignedUrl = z.infer<typeof StoragePresignedUrlModel>

/** STS 临时凭证 */
export type StorageCredentials = z.infer<typeof StorageStsModel>
