import { ApiClient } from './core/api.client.js'
import type { z } from 'zod'
import {
  UserModel,
  AuthResultModel,
  SuccessResultModel,
  RegisterDto,
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
  UpdateInfoDto,
  TodoModel,
  TodoCursorModel,
  CreateTodoDto,
  UpdateTodoDto,
  TodoIdInputDto,
  PageQueryTodoDto,
  CursorQueryTodoDto,
  CreateUserDto,
  UpdateUserDto,
  PageQueryUserDto,
  UserIdInputDto,
  ResetUserPasswordDto,
  StoragePresignedUrlModel,
  StorageStsModel,
  GetStorageUploadPresignedUrlDto,
  GetStorageDownloadUrlDto,
  AppPaginateResponse,
  AppCursorPaginateResponse,
} from '@repo/shared'

// ── 类型定义 ──────────────────────────────────────

/** 安全用户 */
export type SafeUser = z.infer<typeof UserModel>

/** 登录/注册结果 */
export type AuthResult = z.infer<typeof AuthResultModel>

/** 通用成功响应 */
export type SuccessResult = z.infer<typeof SuccessResultModel>

/** Todo 条目 */
export type TodoItem = z.infer<typeof TodoModel>

/** 游标 */
export type TodoCursor = z.infer<typeof TodoCursorModel>

/** 预签名上传 URL */
export type StoragePresignedUrl = z.infer<typeof StoragePresignedUrlModel>

/** STS 临时凭证 */
export type StorageCredentials = z.infer<typeof StorageStsModel>

// ── 请求参数类型 ───────────────────────────────────

type RegisterInput = z.infer<typeof RegisterDto>
type LoginInput = z.infer<typeof LoginDto>
type ForgotPasswordInput = z.infer<typeof ForgotPasswordDto>
type ResetPasswordInput = z.infer<typeof ResetPasswordDto>
type ChangePasswordInput = z.infer<typeof ChangePasswordDto>
type UpdateInfoInput = z.infer<typeof UpdateInfoDto>

type CreateTodoInput = z.infer<typeof CreateTodoDto>
type UpdateTodoInput = z.infer<typeof UpdateTodoDto>
type TodoIdInput = z.infer<typeof TodoIdInputDto>
type PageQueryTodoInput = z.infer<typeof PageQueryTodoDto>
type CursorQueryTodoInput = z.infer<typeof CursorQueryTodoDto>

type CreateUserInput = z.infer<typeof CreateUserDto>
type UpdateUserInput = z.infer<typeof UpdateUserDto>
type PageQueryUserInput = z.infer<typeof PageQueryUserDto>
type UserIdInput = z.infer<typeof UserIdInputDto>
type ResetUserPasswordInput = z.infer<typeof ResetUserPasswordDto>

type GetPresignedUrlInput = z.infer<typeof GetStorageUploadPresignedUrlDto>
type GetDownloadUrlInput = z.infer<typeof GetStorageDownloadUrlDto>

/**
 * ServerClient — 继承 ApiClient，提供全类型化的业务 API 调用。
 *
 * 所有方法均以 POST 方式请求后端，自动处理 AppResponse 包裹/解包和鉴权。
 *
 * 用法：
 * ```ts
 * const client = new ServerClient({ ... })
 * const { token, user } = await client.auth.login({ email, password })
 * const todos = await client.todo.findManyCursor({ size: 20 })
 * ```
 */
export class ServerClient<
  Credentials = Record<string, any>,
> extends ApiClient<Credentials> {
  /* ========== 认证 ========== */

  auth = {
    /** 无需 token */
    register: (input: RegisterInput) =>
      this.postPublic<AuthResult>('/auth/register', input),

    /** 无需 token */
    login: (input: LoginInput) =>
      this.postPublic<AuthResult>('/auth/login', input),

    /** 无需 token */
    forgotPassword: (input: ForgotPasswordInput) =>
      this.postPublic<SuccessResult>('/auth/forgot-password', input),

    /** 无需 token */
    resetPassword: (input: ResetPasswordInput) =>
      this.postPublic<SuccessResult>('/auth/reset-password', input),

    /** 需要 token */
    getMe: () => this.post<SafeUser>('/auth/get-me'),

    /** 需要 token */
    updateInfo: (input: UpdateInfoInput) =>
      this.post<SafeUser>('/auth/update-info', input),

    /** 需要 token */
    changePassword: (input: ChangePasswordInput) =>
      this.post<SuccessResult>('/auth/change-password', input),
  }

  /* ========== 待办事项 ========== */

  todo = {
    create: (input: CreateTodoInput) =>
      this.post<TodoItem>('/todo/create', input),

    findMany: (input: PageQueryTodoInput) =>
      this.post<AppPaginateResponse<TodoItem>>('/todo/find-many', input),

    findManyCursor: (input: CursorQueryTodoInput) =>
      this.post<AppCursorPaginateResponse<TodoItem, TodoCursor>>('/todo/find-many-cursor', input),

    findById: (input: TodoIdInput) =>
      this.post<TodoItem>('/todo/find-by-id', input),

    update: (input: UpdateTodoInput) =>
      this.post<TodoItem>('/todo/update', input),

    remove: (input: TodoIdInput) =>
      this.post<TodoItem>('/todo/remove', input),
  }

  /* ========== 用户 ========== */

  user = {
    create: (input: CreateUserInput) =>
      this.post<SafeUser>('/user/create', input),

    findMany: (input: PageQueryUserInput) =>
      this.post<AppPaginateResponse<SafeUser>>('/user/find-many', input),

    findById: (input: UserIdInput) =>
      this.post<SafeUser>('/user/find-by-id', input),

    update: (input: UpdateUserInput) =>
      this.post<SafeUser>('/user/update', input),

    remove: (input: UserIdInput) =>
      this.post<SuccessResult>('/user/remove', input),

    resetPassword: (input: ResetUserPasswordInput) =>
      this.post<SuccessResult>('/user/reset-password', input),
  }

  /* ========== 存储 ========== */

  storage = {
    getPresignedUrl: (input: GetPresignedUrlInput) =>
      this.post<StoragePresignedUrl>('/storage/get-presigned-url', input),

    getDownloadUrl: (input: GetDownloadUrlInput) =>
      this.post<{ url: string }>('/storage/get-download-url', input),

    getTemporaryCredentials: () =>
      this.post<StorageCredentials>('/storage/get-temporary-credentials'),
  }
}
