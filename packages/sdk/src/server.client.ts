import {
  AdminAuthResultModel,
  AdminLoginDto,
  AdminModel,
  AdminUpdateInfoDto,
  AppConfigModel,
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
  CreateAlertRuleDto,
  UpdateAlertRuleDto,
  GetAlertRuleDetailDto,
  RemoveAlertRuleDto,
  PageQueryAlertRuleDto,
  PageQueryAlertLogDto,
  TestAlertDto,
  AlertRuleModel,
  AlertLogModel,
  MonitorHealthModel,
  UpdateTodoDto,
  UpdateUserDto,
  UserModel,
} from '@repo/shared'
import { HttpClient, HttpStreamClient, type HttpClientOptions } from '@repo/http-client'
import type {
  BearerTokenCredentials,
  CredentialsManager,
} from '@repo/http-client'
import { BearerTokenStrategy } from '@repo/http-client'

/** SSE 长连接创建选项 */
export interface CreateStreamOptions {
  /**
   * 业务频道（如 `task:42`）。
   * 身份频道（`user:{id}` / `admin:{id}`）与广播频道由服务端按登录身份强制注入，
   * 客户端无需（也不应）指定 —— 请求里的 `user:*` / `admin:*` 会被服务端忽略。
   */
  channels?: string[]
  /** 浏览器：页面隐藏时是否保持连接，默认 false（隐藏断开、恢复后自动重连） */
  openWhenHidden?: boolean
}

/** SSE 订阅路由（与 apps/server 的 StreamController 对应） */
const STREAM_SUBSCRIBE_PATH = '/sse/subscribe'

export class ServerClient extends HttpClient<BearerTokenCredentials> {
  /** SSE 长连接复用的凭证（与普通请求同一份，避免「HTTP 认证了、推流没认证」） */
  private readonly streamCredentials: CredentialsManager<BearerTokenCredentials>
  /** SSE 订阅地址：完整 URL（客户端不做 baseUrl 拼接，故在构造期算好） */
  private readonly streamUrl: string

  constructor(
    options: Omit<HttpClientOptions<BearerTokenCredentials>, 'authStrategy'>,
  ) {
    super({
      ...options,
      authStrategy: new BearerTokenStrategy(),
    })
    this.streamCredentials = options.credentialsManager
    this.streamUrl = `${options.baseUrl.replace(/\/+$/, '')}${STREAM_SUBSCRIBE_PATH}`
  }

  /**
   * 建立 SSE 长连接（服务端推送）。
   *
   * 复用本客户端同一份 `baseUrl` / 凭证 / Bearer 策略，调用方无需重复配置认证 —— 这正是
   * 「SSE 归 sdk」的价值：登录态只有一处定义，HTTP 与推流不会各自漂移。
   *
   * 返回的客户端由调用方负责生命周期：React 页面请交给 `@repo/ui` 的 `useStream`，
   * 手工使用务必在结束时 `close()`（否则长连接泄漏）。
   */
  createStream(options: CreateStreamOptions = {}): HttpStreamClient<BearerTokenCredentials> {
    return new HttpStreamClient({
      url: this.streamUrl,
      channels: options.channels ?? [],
      credentialsManager: this.streamCredentials,
      authStrategy: new BearerTokenStrategy(),
      openWhenHidden: options.openWhenHidden,
    })
  }

  /* ========== 应用配置 ========== */

  config = {
    /** 无需 token：获取运行配置（如用户体系开关），据此控制前端 UI */
    get: () => this.post<AppConfigModel>('/config/get', undefined, { skipAuth: true }),
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

  /* ========== 监控告警 ========== */

  monitor = {
    rule: {
      create: (data: CreateAlertRuleDto) =>
        this.post<AlertRuleModel>('/monitor/rule/create', data),

      pageQuery: (data: PageQueryAlertRuleDto) =>
        this.post<AppPageQueryResponse<AlertRuleModel>>(
          '/monitor/rule/page-query',
          data,
        ),

      detail: (data: GetAlertRuleDetailDto) =>
        this.post<AlertRuleModel>('/monitor/rule/detail', data),

      update: (data: UpdateAlertRuleDto) =>
        this.post<AlertRuleModel>('/monitor/rule/update', data),

      remove: (data: RemoveAlertRuleDto) =>
        this.post<AlertRuleModel>('/monitor/rule/remove', data),
    },

    log: {
      pageQuery: (data: PageQueryAlertLogDto) =>
        this.post<AppPageQueryResponse<AlertLogModel>>(
          '/monitor/log/page-query',
          data,
        ),
    },

    test: (data: TestAlertDto) =>
      this.post<SuccessResultModel>('/monitor/test', data),

    health: () =>
      this.post<MonitorHealthModel>('/monitor/health', undefined, { skipAuth: true }),
  }
}
