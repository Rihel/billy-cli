import { ApiClient } from './api.client.js'
import { ResponseUtils } from '@repo/shared'
import type {
  SafeUser,
  AuthResult,
  SuccessResult,
  TodoItem,
  TodoCursor,
  TodoCursorPage,
  PaginatedResult,
  StoragePresignedUrl,
  StorageCredentials,
} from './server.types.js'

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
export class ServerClient<Credentials = Record<string, any>>
  extends ApiClient<Credentials>
{
  /**
   * 发送需要鉴权的 POST 请求。
   */
  protected async post<Res>(
    endpoint: string,
    body?: Record<string, any>,
  ): Promise<Res> {
    const response = await this.request<Record<string, any>, Res>({
      method: 'POST',
      url: endpoint,
      data: body,
    })
    if (ResponseUtils.isError(response)) {
      throw new Error(response.message || '请求失败')
    }
    return response.data as Res
  }

  /**
   * 发送无需鉴权的 POST 请求（如 login, register）。
   */
  protected async postPublic<Res>(
    endpoint: string,
    body?: Record<string, any>,
  ): Promise<Res> {
    const response = await this.request<Record<string, any>, Res>({
      method: 'POST',
      url: endpoint,
      data: body,
      skipAuth: true,
    })
    if (ResponseUtils.isError(response)) {
      throw new Error(response.message || '请求失败')
    }
    return response.data as Res
  }

  /* ========== Auth ========== */

  auth = {
    /** 无需 token */
    register: (input: {
      email: string
      password: string
      realName?: string
    }) => this.postPublic<AuthResult>('/api/auth/register', input),

    /** 无需 token */
    login: (input: { email: string; password: string }) =>
      this.postPublic<AuthResult>('/api/auth/login', input),

    /** 无需 token */
    forgotPassword: (input: { email: string }) =>
      this.postPublic<SuccessResult>('/api/auth/forgot-password', input),

    /** 无需 token */
    resetPassword: (input: { token: string; password: string }) =>
      this.postPublic<SuccessResult>('/api/auth/reset-password', input),

    /** 需要 token */
    getMe: () => this.post<SafeUser>('/api/auth/get-me'),

    /** 需要 token */
    updateInfo: (input: {
      realName?: string | null
      avatar?: string | null
    }) => this.post<SafeUser>('/api/auth/update-info', input),

    /** 需要 token */
    changePassword: (input: { oldPassword: string; newPassword: string }) =>
      this.post<SuccessResult>('/api/auth/change-password', input),
  }

  /* ========== Todo ========== */

  todo = {
    create: (input: { title: string }) =>
      this.post<TodoItem>('/api/todo/create', input),

    findMany: (input: {
      page?: number
      size?: number
      keyword?: string
      orderBy?: string
      order?: string
    }) => this.post<PaginatedResult<TodoItem>>('/api/todo/find-many', input),

    findManyCursor: (input: {
      cursor?: TodoCursor
      keyword?: string
      size?: number
    }) => this.post<TodoCursorPage>('/api/todo/find-many-cursor', input),

    findById: (input: { todoId: string }) =>
      this.post<TodoItem>('/api/todo/find-by-id', input),

    update: (input: {
      todoId: string
      title: string
      description?: string
      completed?: boolean
    }) => this.post<TodoItem>('/api/todo/update', input),

    remove: (input: { todoId: string }) =>
      this.post<TodoItem>('/api/todo/remove', input),
  }

  /* ========== User ========== */

  user = {
    create: (input: {
      email: string
      password: string
      realName?: string
      avatar?: string | null
    }) => this.post<SafeUser>('/api/user/create', input),

    findMany: (input: {
      page?: number
      size?: number
      keyword?: string
      orderBy?: string
      order?: string
    }) => this.post<PaginatedResult<SafeUser>>('/api/user/find-many', input),

    findById: (input: { userId: string }) =>
      this.post<SafeUser>('/api/user/find-by-id', input),

    update: (input: {
      userId: string
      realName?: string | null
      avatar?: string | null
    }) => this.post<SafeUser>('/api/user/update', input),

    remove: (input: { userId: string }) =>
      this.post<SuccessResult>('/api/user/remove', input),

    resetPassword: (input: { userId: string; password: string }) =>
      this.post<SuccessResult>('/api/user/reset-password', input),
  }

  /* ========== Storage ========== */

  storage = {
    getPresignedUrl: (input: { key: string; access?: string }) =>
      this.post<StoragePresignedUrl>('/api/storage/get-presigned-url', input),

    getDownloadUrl: (input: { key: string }) =>
      this.post<{ url: string }>('/api/storage/get-download-url', input),

    getTemporaryCredentials: () =>
      this.post<StorageCredentials>(
        '/api/storage/get-temporary-credentials',
      ),
  }
}
