import {
  AppCursorQueryResponse,
  AppPageQueryResponse,
  AuthResultModel,
  AuthUserModel,
  ChangePasswordDto,
  CreateTodoDto,
  CreateUserDto,
  CursorQueryTodoDto,
  ForgotPasswordDto,
  GetDetailTodoDto,
  GetStorageDownloadUrlDto,
  GetStorageUploadPresignedUrlDto,
  GetUserDetailDto,
  LoginDto,
  PageQueryTodoDto,
  PageQueryUserDto,
  RegisterDto,
  RemoveTodoDto,
  RemoveUserDto,
  ResetPasswordDto,
  ResetUserPasswordDto,
  StoragePresignedUrlModel,
  StorageStsModel,
  SuccessResultModel,
  TodoCursorModel,
  TodoModel,
  UpdateInfoDto,
  UpdateTodoDto,
  UpdateUserDto,
  UserModel,
} from '@repo/shared'
import { ApiClient, ApiClientOptions } from './core/api.client.js'
import {
  BearerTokenCredentials,
  BearerTokenStrategy,
} from './strategies/bearer-token.strategy.js'

export class ServerClient extends ApiClient<BearerTokenCredentials> {
  constructor(
    options: Omit<ApiClientOptions<BearerTokenCredentials>, 'authStrategy'>,
  ) {
    super({
      ...options,
      authStrategy: new BearerTokenStrategy(),
    })
  }
  /* ========== 认证 ========== */

  auth = {
    /** 无需 token */
    register: (data: RegisterDto) =>
      this.post<AuthResultModel>('/auth/register', data, { skipAuth: true }),

    /** 无需 token */
    login: (data: LoginDto) =>
      this.post<AuthResultModel>('/auth/login', data, { skipAuth: true }),

    /** 无需 token */
    forgotPassword: (data: ForgotPasswordDto) =>
      this.post<SuccessResultModel>('/auth/forgot-password', data, {
        skipAuth: true,
      }),

    /** 无需 token */
    resetPassword: (data: ResetPasswordDto) =>
      this.post<SuccessResultModel>('/auth/reset-password', data, {
        skipAuth: true,
      }),

    /** 需要 token */
    getMe: () => this.post<AuthUserModel>('/auth/get-me'),

    /** 需要 token */
    updateInfo: (data: UpdateInfoDto) =>
      this.post<AuthUserModel>('/auth/update-info', data),

    /** 需要 token */
    changePassword: (data: ChangePasswordDto) =>
      this.post<SuccessResultModel>('/auth/change-password', data),
  }

  /* ========== 待办事项 ========== */

  todo = {
    create: (data: CreateTodoDto) => this.post<TodoModel>('/todo/create', data),

    pageQuery: (data: PageQueryTodoDto) =>
      this.post<AppPageQueryResponse<TodoModel>>('/todo/page-query', data),

    cursorQuery: (data: CursorQueryTodoDto) =>
      this.post<AppCursorQueryResponse<TodoModel, TodoCursorModel>>(
        '/todo/cursor-query',
        data,
      ),

    detail: (data: GetDetailTodoDto) =>
      this.post<TodoModel>('/todo/detail', data),

    update: (data: UpdateTodoDto) => this.post<TodoModel>('/todo/update', data),

    remove: (data: RemoveTodoDto) => this.post<TodoModel>('/todo/remove', data),
  }

  /* ========== 用户 ========== */

  user = {
    create: (data: CreateUserDto) => this.post<UserModel>('/user/create', data),

    pageQuery: (data: PageQueryUserDto) =>
      this.post<AppPageQueryResponse<UserModel>>('/user/page-query', data),

    detail: (data: GetUserDetailDto) =>
      this.post<UserModel>('/user/detail', data),

    update: (data: UpdateUserDto) => this.post<UserModel>('/user/update', data),

    remove: (data: RemoveUserDto) =>
      this.post<SuccessResultModel>('/user/remove', data),

    resetPassword: (data: ResetUserPasswordDto) =>
      this.post<SuccessResultModel>('/user/reset-password', data),
  }

  /* ========== 存储 ========== */

  storage = {
    getPresignedUrl: (data: GetStorageUploadPresignedUrlDto) =>
      this.post<StoragePresignedUrlModel>('/storage/get-presigned-url', data),

    getDownloadUrl: (data: GetStorageDownloadUrlDto) =>
      this.post<StoragePresignedUrlModel>('/storage/get-download-url', data),

    getTemporaryCredentials: () =>
      this.post<StorageStsModel>('/storage/get-temporary-credentials'),
  }
}
