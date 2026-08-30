import {
  AdminAuthResultModel,
  AdminLoginDto,
  AdminModel,
  AdminUpdateInfoDto,
  AppCursorQueryResponse,
  AppPageQueryResponse,
  AuthResultModel,
  AuthUserModel,
  ChangePasswordDto,
  CreateAdminDto,
  CreateTodoDto,
  CreateUserDto,
  CursorQueryTodoDto,
  ForgotPasswordDto,
  GetAdminDetailDto,
  GetDetailTodoDto,
  GetStorageDownloadUrlDto,
  GetStorageUploadPresignedUrlDto,
  GetUserDetailDto,
  LoginDto,
  PageQueryAdminDto,
  PageQueryTodoDto,
  PageQueryUserDto,
  RegisterDto,
  RemoveAdminDto,
  RemoveTodoDto,
  RemoveUserDto,
  ResetAdminPasswordDto,
  ResetPasswordDto,
  ResetUserPasswordDto,
  StoragePresignedUrlModel,
  StorageStsModel,
  SuccessResultModel,
  TodoCursorModel,
  TodoModel,
  UpdateAdminDto,
  UpdateInfoDto,
  UpdateTodoDto,
  UpdateUserDto,
  UserModel,
} from '@repo/shared'
import { ApiClient, type ApiClientOptions } from '@repo/http-client'
import type {
  BearerTokenCredentials,
} from '@repo/http-client'
import { BearerTokenStrategy } from '@repo/http-client'

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

    /** 登出（幂等：撤销服务端会话，不要求登录态） */
    logout: () =>
      this.post<SuccessResultModel>('/auth/logout', undefined, {
        skipAuth: true,
      }),

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

  /* ========== 后台管理员 ========== */

  admin = {
    /** 无需 token */
    login: (data: AdminLoginDto) =>
      this.post<AdminAuthResultModel>('/admin/login', data, {
        skipAuth: true,
      }),

    /** 登出（幂等：撤销服务端会话，不要求登录态） */
    logout: () =>
      this.post<SuccessResultModel>('/admin/logout', undefined, {
        skipAuth: true,
      }),

    /** 需要管理员 token */
    getMe: () => this.post<AdminModel>('/admin/get-me'),

    /** 需要管理员 token：更新个人信息 */
    updateInfo: (data: AdminUpdateInfoDto) =>
      this.post<AdminModel>('/admin/update-info', data),

    /** 需要管理员 token：修改自己的密码 */
    changePassword: (data: ChangePasswordDto) =>
      this.post<SuccessResultModel>('/admin/change-password', data),

    /** 需要管理员 token：创建管理员 */
    create: (data: CreateAdminDto) =>
      this.post<AdminModel>('/admin/create', data),

    /** 需要管理员 token：管理员分页查询 */
    pageQuery: (data: PageQueryAdminDto) =>
      this.post<AppPageQueryResponse<AdminModel>>('/admin/page-query', data),

    /** 需要管理员 token：管理员详情 */
    detail: (data: GetAdminDetailDto) =>
      this.post<AdminModel>('/admin/detail', data),

    /** 需要管理员 token：更新管理员 */
    update: (data: UpdateAdminDto) =>
      this.post<AdminModel>('/admin/update', data),

    /** 需要管理员 token：删除管理员（不能删除自己） */
    remove: (data: RemoveAdminDto) =>
      this.post<SuccessResultModel>('/admin/remove', data),

    /** 需要管理员 token：重置管理员密码 */
    resetPassword: (data: ResetAdminPasswordDto) =>
      this.post<SuccessResultModel>('/admin/reset-password', data),
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
