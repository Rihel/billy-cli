import {
  MarketItemKeyDto,
  MarketItemListDto,
  MarketItemModel,
  MarketItemSaveDto,
  AiAvailableModelListModel,
  CapabilityServiceIdDto,
  CapabilityServiceListDto,
  CapabilityServiceModel,
  CapabilityServiceSaveDto,
  CapabilityServiceStatusDto,
  CapabilityServiceCapabilityDto,
  CapabilityServiceMcpPullDto,
  CapabilityServiceTestDto,
  ServiceGrantModel,
  ServiceGrantSetDto,
  CapabilityServiceTestResultDto,
  AiModelCreateDto,
  AiModelIdDto,
  AiModelListDto,
  AiModelModel,
  AiModelUpdateDto,
  AiProviderCreateDto,
  AiProviderIdDto,
  AiProviderKeyCreateDto,
  AiProviderKeyIdDto,
  AiProviderKeyListDto,
  AiProviderKeyModel,
  AiProviderKeyUpdateDto,
  AiProviderListDto,
  AiProviderModel,
  AiProviderSyncResultModel,
  AiProviderTestDto,
  AiProviderTestResultModel,
  AiProviderUpdateDto,
  AiSkillCreateDto,
  AiSkillDetailModel,
  AiSkillFileContentModel,
  AiSkillFileReadDto,
  AiSkillFileRemoveDto,
  AiSkillFileSaveDto,
  AiSkillImportDto,
  AiSkillImportPreviewDto,
  AiSkillImportPreviewResultModel,
  AiSkillImportResultModel,
  AiSkillKeyDto,
  SkillGrantListDto,
  SkillGrantModel,
  SkillGrantSetDto,
  AiSkillListDto,
  AiSkillModel,
  AiMemoryListDto,
  AiMemoryModel,
  AiMemoryRemoveDto,
  AiMemoryUpdateDto,
  AiSkillUpdateDto,
  CredentialBindDto,
  CredentialIdDto,
  CredentialListDto,
  CredentialModel,
  CredentialUpdateInjectDto,
  AiToolKeyDto,
  AiToolListDto,
  AiToolModel,
  AiToolUpdateDto,
  AiToolWorkspaceStatusModel,
  AdminAuthResultModel,
  AdminLoginDto,
  AdminModel,
  AdminUpdateInfoDto,
  AppConfigModel,
  AppPageQueryResponse,
  AuthResultModel,
  AuthUserModel,
  ChangePasswordDto,
  CreateAdminDto,
  CreateShareDto,
  CreateShareModel,
  CreateUserDto,
  ForgotPasswordDto,
  GetAdminDetailDto,
  GetStorageDownloadUrlDto,
  GetStorageUploadPresignedUrlDto,
  GetUserDetailDto,
  ListShareDto,
  ListShareModel,
  ShareMetaModel,
  ShareTokenDto,
  LoginDto,
  PageQueryAdminDto,
  PageQueryUserDto,
  RegisterDto,
  RemoveAdminDto,
  RemoveSessionDto,
  RemoveUserDto,
  ResetAdminPasswordDto,
  ResetPasswordDto,
  ResetUserPasswordDto,
  RevokeShareDto,
  SessionListModel,
  StoragePresignedUrlModel,
  StorageStsModel,
  SuccessResultModel,
  UpdateAdminDto,
  UpdateInfoDto,
  GetMonitorAlertDetailDto,
  ListMonitorRuleDto,
  MonitorAlertDeliveryModel,
  MonitorAlertDetailModel,
  MonitorAlertModel,
  MonitorEngineStatusModel,
  MonitorHealthModel,
  MonitorMetricDefinitionModel,
  MonitorMetricLatestModel,
  MonitorMetricLatestQueryDto,
  MonitorMetricSeriesDto,
  MonitorMetricSeriesModel,
  MonitorRuleDefinitionModel,
  MonitorRuleModel,
  PageQueryMonitorAlertDto,
  PageQueryMonitorLogDto,
  ResetMonitorRuleDto,
  TestAlertDto,
  UpdateMonitorRuleDto,
  UpdateUserDto,
  UserModel,
  AgentChatDto,
  AgentChatResultModel,
  AgentConversationCreateDto,
  AgentConversationIdDto,
  AgentConversationListDto,
  AgentConversationModel,
  AgentFileAdminListDto,
  AgentFileAdminListModel,
  AgentFileAdminStatsDto,
  AgentFileAdminStatsModel,
  AgentFileAdminPreviewDto,
  AgentFileLinkModel,
  AgentFileWorkspaceLinkDto,
  AgentFilePreviewModel,
  AgentWorkspaceListModel,
  AgentConversationFileAccessDto,
  AgentConversationRenameDto,
  AgentInstructionsDto,
  AgentInstructionsModel,
  AgentListModel,
  AgentRunDetailModel,
  AgentRunIdDto,
  AgentRunListDto,
  AgentRunModel,
  AgentRunSnapshotModel,
  AgentRunStopDto,
  AgentRunStopResultModel,
  AgentStatusModel,
  AgentTimelineItemModel,
  AgentTimelineListDto,
  AgentRunQueueItemModel,
  AgentRunQueueListDto,
  AgentRunQueueRemoveDto,
  AgentRunQueueUpdateDto,
  AgentUsageSummaryModel,
  GatewayUsageItemModel,
  GatewayUsageListDto,
  GatewayUsageReconcileDto,
  GatewayUsageReconcileResultModel,
  GatewayUsageSummaryModel,
  GatewayUsageSummaryQueryDto,
  AgentUsageSummaryQueryDto,
  AgentUsageRangeDto,
  WorkspaceModel,
  WorkspaceCreateDto,
  WorkspaceUpdateDto,
  WorkspaceIdDto,
} from '@repo/shared'
import { HttpClient, HttpStreamClient, type HttpClientOptions } from '@repo/http-client'
import type { BearerTokenCredentials, CredentialsManager } from '@repo/http-client'
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

/** SSE 订阅路由（与 apps/main 的 StreamController 对应） */
const STREAM_SUBSCRIBE_PATH = '/sse/subscribe'

/** 建流路由：响应体是 AI SDK v6 的 UI Message Stream（**不套业务信封**） */
const AGENT_CHAT_STREAM_PATH = '/agent/chat/stream'

/** 续流路由：`GET ...?sinceRev=N`，无进行中的流时服务端回 204（AI SDK 续传约定） */
const agentResumeStreamPath = (runId: string): string =>
  `/agent/run/${encodeURIComponent(runId)}/stream`

export class ServerClient extends HttpClient<BearerTokenCredentials> {
  /** SSE 长连接复用的凭证（与普通请求同一份，避免「HTTP 认证了、推流没认证」） */
  private readonly streamCredentials: CredentialsManager<BearerTokenCredentials>
  /** SSE 订阅地址：完整 URL（客户端不做 baseUrl 拼接，故在构造期算好） */
  private readonly streamUrl: string
  /** 规范化后的 baseUrl（无尾斜杠）：给 AI SDK transport 拼完整 URL 用 */
  private readonly agentBaseUrl: string

  constructor(options: Omit<HttpClientOptions<BearerTokenCredentials>, 'authStrategy'>) {
    super({
      ...options,
      authStrategy: new BearerTokenStrategy(),
    })
    this.streamCredentials = options.credentialsManager
    this.agentBaseUrl = options.baseUrl.replace(/\/+$/, '')
    this.streamUrl = `${this.agentBaseUrl}${STREAM_SUBSCRIBE_PATH}`
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
    login: (data: LoginDto) => this.post<AuthResultModel>('/auth/login', data, { skipAuth: true }),

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
    updateInfo: (data: UpdateInfoDto) => this.post<AuthUserModel>('/auth/update-info', data),

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
    updateInfo: (data: AdminUpdateInfoDto) => this.post<AdminModel>('/admin/update-info', data),

    /** 需要管理员 token：修改自己的密码 */
    changePassword: (data: ChangePasswordDto) =>
      this.post<SuccessResultModel>('/admin/change-password', data),

    /** 需要管理员 token：创建管理员 */
    create: (data: CreateAdminDto) => this.post<AdminModel>('/admin/create', data),

    /** 需要管理员 token：管理员分页查询 */
    pageQuery: (data: PageQueryAdminDto) =>
      this.post<AppPageQueryResponse<AdminModel>>('/admin/page-query', data),

    /** 需要管理员 token：管理员详情 */
    detail: (data: GetAdminDetailDto) => this.post<AdminModel>('/admin/detail', data),

    /** 需要管理员 token：更新管理员 */
    update: (data: UpdateAdminDto) => this.post<AdminModel>('/admin/update', data),

    /** 需要管理员 token：删除管理员（不能删除自己） */
    remove: (data: RemoveAdminDto) => this.post<SuccessResultModel>('/admin/remove', data),

    /** 需要管理员 token：重置管理员密码 */
    resetPassword: (data: ResetAdminPasswordDto) =>
      this.post<SuccessResultModel>('/admin/reset-password', data),
  }

  /* ========== 用户 ========== */

  user = {
    create: (data: CreateUserDto) => this.post<UserModel>('/user/create', data),

    pageQuery: (data: PageQueryUserDto) =>
      this.post<AppPageQueryResponse<UserModel>>('/user/page-query', data),

    detail: (data: GetUserDetailDto) => this.post<UserModel>('/user/detail', data),

    update: (data: UpdateUserDto) => this.post<UserModel>('/user/update', data),

    remove: (data: RemoveUserDto) => this.post<SuccessResultModel>('/user/remove', data),

    resetPassword: (data: ResetUserPasswordDto) =>
      this.post<SuccessResultModel>('/user/reset-password', data),
  }

  /* ========== 文件分享 ========== */

  share = {
    /** 生成分享链接：返回的 token / url **只此一次**（库里只存哈希） */
    create: (data: CreateShareDto) => this.post<CreateShareModel>('/share/create', data),

    /** 某个文件的历史分享（不含 token） */
    list: (data: ListShareDto) => this.post<ListShareModel>('/share/list', data),

    revoke: (data: RevokeShareDto) => this.post<SuccessResultModel>('/share/revoke', data),

    /** 分享页元信息（公开接口，带 token 即可，无需登录） */
    meta: (data: ShareTokenDto) =>
      this.post<ShareMetaModel>('/share/meta', data, { skipAuth: true }),
  }

  /* ========== 存储 ========== */

  storage = {
    getPresignedUrl: (data: GetStorageUploadPresignedUrlDto) =>
      this.post<StoragePresignedUrlModel>('/storage/get-presigned-url', data),

    getDownloadUrl: (data: GetStorageDownloadUrlDto) =>
      this.post<StoragePresignedUrlModel>('/storage/get-download-url', data),

    getTemporaryCredentials: () => this.post<StorageStsModel>('/storage/get-temporary-credentials'),
  }

  /* ========== 监控告警 ========== */

  monitor = {
    rule: {
      definitions: () => this.post<MonitorRuleDefinitionModel[]>('/monitor/rule/definitions', {}),

      list: (data: ListMonitorRuleDto) => this.post<MonitorRuleModel[]>('/monitor/rule/list', data),

      update: (data: UpdateMonitorRuleDto) =>
        this.post<MonitorRuleModel>('/monitor/rule/update', data),

      reset: (data: ResetMonitorRuleDto) =>
        this.post<MonitorRuleModel>('/monitor/rule/reset', data),
    },

    alert: {
      pageQuery: (data: PageQueryMonitorAlertDto) =>
        this.post<AppPageQueryResponse<MonitorAlertModel>>('/monitor/alert/page-query', data),

      detail: (data: GetMonitorAlertDetailDto) =>
        this.post<MonitorAlertDetailModel>('/monitor/alert/detail', data),
    },

    metric: {
      definitions: () =>
        this.post<MonitorMetricDefinitionModel[]>('/monitor/metric/definitions', {}),

      series: (data: MonitorMetricSeriesDto) =>
        this.post<MonitorMetricSeriesModel>('/monitor/metric/series', data),

      latest: (data: MonitorMetricLatestQueryDto) =>
        this.post<MonitorMetricLatestModel[]>('/monitor/metric/latest', data),
    },

    engine: {
      status: () => this.post<MonitorEngineStatusModel>('/monitor/engine/status', {}),
    },

    log: {
      pageQuery: (data: PageQueryMonitorLogDto) =>
        this.post<AppPageQueryResponse<MonitorAlertDeliveryModel>>('/monitor/log/page-query', data),
    },

    test: (data: TestAlertDto) => this.post<SuccessResultModel>('/monitor/test', data),

    health: () => this.post<MonitorHealthModel>('/monitor/health', undefined, { skipAuth: true }),
  }

  /* ========== AI 对话 ========== */

  /**
   * AI 能力（会话 / 运行 / 时间线）。
   *
   * 三条**不走 HttpClient 管线**的旁路，因为请求由 AI SDK / 流式 fetch 自己发出：
   * - {@link ServerClient.chatStreamUrl}（POST 建流）
   * - {@link ServerClient.chatResumeUrl}（POST 回答挂起，响应仍是 SSE）
   * - {@link ServerClient.resumeStreamUrl}（GET 续流，断线重连）
   * 它们都需要鉴权头，故另给 {@link ServerClient.authHeaders}。
   */
  agent = {
    /** AI 能力状态（是否可用、默认 agent、可用 agent 数） */
    status: () => this.post<AgentStatusModel>('/agent/status'),

    /** agent 清单（含 skills 与子 agent，供前端选择器与能力展示） */
    list: () => this.post<AgentListModel>('/agent/list'),

    /** 某个 agent 的**系统指令原文**（前端「查看系统指令」） */
    instructions: (data: AgentInstructionsDto) =>
      this.post<AgentInstructionsModel>('/agent/instructions', data),

    /** 一轮问答（非流式）：跑完才返回，期间无任何输出 */
    chat: (data: AgentChatDto) => this.post<AgentChatResultModel>('/agent/chat', data),

    /** 停止某一轮（幂等；跨副本时服务端内部广播，前端无需关心） */
    stopRun: (data: AgentRunStopDto) => this.post<AgentRunStopResultModel>('/agent/run/stop', data),

    conversation: {
      /** 新建会话（省略 agentKey 用默认 agent） */
      create: (data: AgentConversationCreateDto) =>
        this.post<AgentConversationModel>('/agent/conversation/create', data),

      /** 会话分页（按最近活跃排序） */
      list: (data: AgentConversationListDto) =>
        this.post<AppPageQueryResponse<AgentConversationModel>>('/agent/conversation/list', data),

      detail: (data: AgentConversationIdDto) =>
        this.post<AgentConversationModel>('/agent/conversation/detail', data),

      /** 重命名会话（用户手动改名；空标题 / 超长由服务端数据结构拦下） */
      rename: (data: AgentConversationRenameDto) =>
        this.post<AgentConversationModel>('/agent/conversation/rename', data),

      /** 切换会话的文件权限（只读 / 可写）：只影响沙箱内的写权限 */
      setFileAccess: (data: AgentConversationFileAccessDto) =>
        this.post<AgentConversationModel>('/agent/conversation/file-access', data),

      /** 软删会话（唯一的删除入口；运行记录与时间线不提供删除） */
      remove: (data: AgentConversationIdDto) =>
        this.post<SuccessResultModel>('/agent/conversation/remove', data),
    },

    /**
     * 会话文件 / 工作区。
     *
     * `workspaceContentUrl` 是给 `<img>` / `<video>` / `<iframe>` 用的完整 GET 地址：
     * 这些标签带不上 Authorization，按身份读 `access-token` / `admin-access-token` cookie（与 SSR 同一套）。
     */
    file: {
      workspace: (data: { conversationId: string; includeCaches?: boolean }) =>
        this.post<AgentWorkspaceListModel>('/agent/file/workspace', data),

      preview: (data: { conversationId: string; path: string; source?: 'ai' | 'workspace' }) =>
        this.post<AgentFilePreviewModel>('/agent/file/preview', data),

      /** 工作区文件 → 临时 OSS 对象链接；前端拿 url 直接 fetch */
      workspaceLink: (data: AgentFileWorkspaceLinkDto) =>
        this.post<AgentFileLinkModel>('/agent/file/workspace-link', data),

      /** 后台独立文件页：全量列表（管理员） */
      adminList: (data: AgentFileAdminListDto) =>
        this.post<AgentFileAdminListModel>('/agent/file/admin/list', data),

      /** 后台独立文件页：总量统计（管理员） */
      adminStats: (data: AgentFileAdminStatsDto) =>
        this.post<AgentFileAdminStatsModel>('/agent/file/admin/stats', data),

      /** 后台独立文件页：文本预览（管理员；任意会话） */
      adminPreview: (data: AgentFileAdminPreviewDto) =>
        this.post<AgentFilePreviewModel>('/agent/file/admin/preview', data),

      workspaceContentUrl: (data: { conversationId: string; path: string; download?: boolean }) => {
        const query = new URLSearchParams({
          conversationId: data.conversationId,
          path: data.path,
        })
        if (data.download) query.set('download', '1')
        return `${this.agentBaseUrl}/agent/file/workspace-content?${query.toString()}`
      },
    },

    run: {
      /**
       * 运行列表（审计 / 复盘）：**含子 agent 的 run**，带 `parentRunId` / `depth`，
       * 调用方据此拼父子树。
       */
      list: (data: AgentRunListDto) =>
        this.post<AppPageQueryResponse<AgentRunModel>>('/agent/run/list', data),

      /** 运行详情：**输入快照**（送给模型的输入、子 agent 的提示词与任务）+ 错误原文 + 子 run */
      detail: (data: AgentRunIdDto) => this.post<AgentRunDetailModel>('/agent/run/detail', data),
    },

    /**
     * 本轮可选的模型清单（**只有"供应商启用 + 模型启用"的**）。
     *
     * 会话页的选择器用它渲染；`defaultModelId` 就是未选择时用的那个（库空时为 null →
     * 前端应当提示"先去后台配模型"）。
     */
    models: () => this.post<AiAvailableModelListModel>('/agent/models'),

    /** 待执行队列（输入框上方展示；只操作 source=user 的 queued 项） */
    queue: {
      list: (data: AgentRunQueueListDto) =>
        this.post<AgentRunQueueItemModel[]>('/agent/queue/list', data),
      update: (data: AgentRunQueueUpdateDto) =>
        this.post<AgentRunQueueItemModel>('/agent/queue/update', data),
      remove: (data: AgentRunQueueRemoveDto) =>
        this.post<{ removed: boolean }>('/agent/queue/remove', data),
    },

    timeline: {
      /** 时间线分页（消息 / 推理 / 工具调用与结果 / 步骤 / 计划 / 摘要…） */
      list: (data: AgentTimelineListDto) =>
        this.post<AppPageQueryResponse<AgentTimelineItemModel>>('/agent/timeline/list', data),
    },

    /** 控制台「AI 用量」汇总（管理员）：近 N 天 token / 轮数 / 成功率 / 分模型与 agent */
    usageSummary: (data: AgentUsageSummaryQueryDto) =>
      this.post<AgentUsageSummaryModel>('/agent/usage/summary', data),

    /** 手动回填 AI 用量日表（管理员） */
    usageRollup: (data: AgentUsageRangeDto) =>
      this.post<{ days: number }>('/agent/usage/rollup', data),

    /** 模型网关调用账（管理员）：逐请求明细 */
    gatewayUsage: {
      list: (data: GatewayUsageListDto) =>
        this.post<AppPageQueryResponse<GatewayUsageItemModel>>('/agent/usage/gateway/list', data),

      /** 调用账汇总（按天 / 模型 / 供应商） */
      summary: (data: GatewayUsageSummaryQueryDto) =>
        this.post<GatewayUsageSummaryModel>('/agent/usage/gateway/summary', data),

      /** 与 runs.usage 对账（只读差异，不自动修正） */
      reconcile: (data: GatewayUsageReconcileDto) =>
        this.post<GatewayUsageReconcileResultModel>('/agent/usage/gateway/reconcile', data),
    },

    /** POST 建流地址（交给 AI SDK transport 的 `api`） */
    chatStreamUrl: (): string => `${this.agentBaseUrl}${AGENT_CHAT_STREAM_PATH}`,

    /** POST 续跑地址（回答 `ask-user-questions` 的挂起；响应同样是 SSE） */
    chatResumeUrl: (): string => `${this.agentBaseUrl}/agent/chat/resume`,

    /** GET 续流地址（知道 runId 时用；交给 AI SDK transport 的 `prepareReconnectToStreamRequest`） */
    resumeStreamUrl: (runId: string, sinceRev = 0): string =>
      `${this.agentBaseUrl}${agentResumeStreamPath(runId)}?sinceRev=${sinceRev}`,

    /**
     * GET 续流地址（**不知道 runId 时用**）：服务端按登录用户 + 指定会话找当前进行中的那一轮，
     * 没有就回 204。`useChat({ resume: true })` 挂载时该用它 —— 刷新 / 换设备都能接回，
     * 且不会在"没有进行中的流"时打到只收 POST 的建流路由（那会 404）。
     *
     * **务必传 `conversationId`**：不传则服务端只按用户跨会话找最近一条，切到已结束的会话
     * 会接上别的会话正在跑的流（串流）。新会话页传占位段 `new`，永不匹配任何 run。
     */
    currentRunStreamUrl: (sinceRev = 0, conversationId?: string): string =>
      `${this.agentBaseUrl}/agent/run/stream?sinceRev=${sinceRev}${
        conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : ''
      }`,

    /**
     * 正在跑的那一轮的**已闭合内容快照**（没有进行中的轮 → null）。
     *
     * 恢复链路先拿它渲染已完成部分，再从 `sinceRev` 接增量 —— 不必整轮重放。
     * `runId` 与 `conversationId` 二选一；只知道会话 id 时传后者。
     */
    snapshotUrl: (conversationId?: string): string =>
      `${this.agentBaseUrl}/agent/run/snapshot${
        conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''
      }`,

    runSnapshotUrl: (runId: string): string =>
      `${this.agentBaseUrl}/agent/run/${encodeURIComponent(runId)}/snapshot`,

    snapshot: (data: {
      conversationId?: string
      runId?: string
    }): Promise<AgentRunSnapshotModel | null> =>
      /**
       * 走 `HttpClient.get` 而不是裸 fetch：401 刷新 / 登出 / 错误信封与其它接口同一套。
       * 服务端没有进行中的轮时返回 `{ code: 0, data: null }`（不再是 204）。
       */
      data.runId
        ? this.get<AgentRunSnapshotModel | null>(
            `/agent/run/${encodeURIComponent(data.runId)}/snapshot`,
          )
        : this.get<AgentRunSnapshotModel | null>(
            '/agent/run/snapshot',
            data.conversationId ? { conversationId: data.conversationId } : undefined,
          ),

    /**
     * 当前凭证的鉴权头（给 AI SDK transport 用）。
     *
     * 走的是与普通请求**同一套** authStrategy，故头格式只有一处定义；
     * 未登录返回 `{}`（后端会回 401，与普通请求行为一致）。
     */
    authHeaders: async (): Promise<Record<string, string>> => {
      const credentials = await this.streamCredentials.getCredentials()
      if (!credentials?.token) return {}
      // 策略接口要求传一份"当前请求上下文"（它可能据此改 URL / body，如 HMAC 策略）；
      // Bearer 策略只看凭证，故这里给一份最小的空上下文
      const context = await this.authStrategy.getAuthContext(credentials, { headers: {} })
      return context.headers ?? {}
    },
  }

  /* ========== AI 模型与供应商（后台管理） ========== */

  /**
   * 模型管理（**管理员鉴权**）：供应商与模型的增删改查 + "从供应商接口拉模型明细"。
   *
   * 这里的配置就是 agent 能用的**全部**模型（§4.9），没有环境变量兜底路径。
   */
  aiModel = {
    provider: {
      list: (data: AiProviderListDto) =>
        this.post<AppPageQueryResponse<AiProviderModel>>('/ai-model/provider/list', data),

      /** 新建供应商（`apiKey` 只进不出：响应只回提示） */
      create: (data: AiProviderCreateDto) =>
        this.post<AiProviderModel>('/ai-model/provider/create', data),

      detail: (data: AiProviderIdDto) =>
        this.post<AiProviderModel>('/ai-model/provider/detail', data),

      /** 更新（`apiKey` 省略 = 不改密钥；给空串 = 清空） */
      update: (data: AiProviderUpdateDto) =>
        this.post<AiProviderModel>('/ai-model/provider/update', data),

      /** 软删供应商（其下模型一并软删） */
      remove: (data: AiProviderIdDto) =>
        this.post<SuccessResultModel>('/ai-model/provider/remove', data),

      /** **从供应商接口拉模型明细**（幂等：重复执行结果一致） */
      sync: (data: AiProviderIdDto) =>
        this.post<AiProviderSyncResultModel>('/ai-model/provider/sync', data),

      /** 连通性测试（支持未保存先测；失败原因回供应商原文） */
      test: (data: AiProviderTestDto) =>
        this.post<AiProviderTestResultModel>('/ai-model/provider/test', data),

      /** 上游 key 池（只回 hasSecret，不回明文） */
      key: {
        list: (data: AiProviderKeyListDto) =>
          this.post<AiProviderKeyModel[]>('/ai-model/provider-key/list', data),

        create: (data: AiProviderKeyCreateDto) =>
          this.post<AiProviderKeyModel>('/ai-model/provider-key/create', data),

        update: (data: AiProviderKeyUpdateDto) =>
          this.post<AiProviderKeyModel>('/ai-model/provider-key/update', data),

        remove: (data: AiProviderKeyIdDto) =>
          this.post<SuccessResultModel>('/ai-model/provider-key/remove', data),
      },
    },

    model: {
      list: (data: AiModelListDto) =>
        this.post<AppPageQueryResponse<AiModelModel>>('/ai-model/model/list', data),

      /** 手工新增（自建网关拉不全 / 想手填窗口时用） */
      create: (data: AiModelCreateDto) => this.post<AiModelModel>('/ai-model/model/create', data),

      update: (data: AiModelUpdateDto) => this.post<AiModelModel>('/ai-model/model/update', data),

      remove: (data: AiModelIdDto) => this.post<SuccessResultModel>('/ai-model/model/remove', data),
    },
  }

  /* ========== AI 工具配置（后台管理） ========== */

  /**
   * 工具配置（**管理员鉴权**）：工具清单 / 详情 / 更新 / 恢复默认。
   *
   * 三条与后端约定绑定的口径：
   * - **秘钥只进不出**：`update` 里的 `secrets` 是唯一写入入口，响应只回 `secretFields[].hint`；
   * - **省略 = 不改**：`update` 只提交要改的字段，`secrets` 里给空串才是清空；
   * - **runtime 工具只读**：Mastra 自带的技能工具 `editable` 为 false，`update` / `reset` 会被拒。
   */
  aiTool = {
    /** 列表：分页 + 关键字 / 类别 / 开关 / 来源筛选 */
    list: (data: AiToolListDto) =>
      this.post<AppPageQueryResponse<AiToolModel>>('/ai-tool/list', data),

    /** 详情：含默认值、秘钥提示串、哪些 agent 授权了它 */
    detail: (data: AiToolKeyDto) => this.post<AiToolModel>('/ai-tool/detail', data),

    /** 更新（省略的字段 = 不改；`secrets` 给空串 = 清空该秘钥） */
    update: (data: AiToolUpdateDto) => this.post<AiToolModel>('/ai-tool/update', data),

    /** 恢复默认（清掉人工覆盖与已配秘钥，回到代码声明） */
    reset: (data: AiToolKeyDto) => this.post<AiToolModel>('/ai-tool/reset', data),

    /** 执行环境能力（只读）：沙箱是否可用、部署允许哪些执行环境 */
    workspace: () => this.post<AiToolWorkspaceStatusModel>('/ai-tool/workspace', {}),
  }

  /* ========== 技能库（后台管理） ========== */

  /**
   * 技能库（**管理员鉴权**）：技能是 Agent Skills 标准的一个目录，
   * 库里保存正文与参考文件，服务端落盘给运行时按需读（设计 `docs/design/ai-skill-library.md`）。
   *
   * 三条口径：
   * - **DB 是事实源**：在线编辑 / 路径导入 / agent 写入都进库，再投影成磁盘目录；
   * - **启停立即生效**：停用会删掉落盘目录，模型看不到它，不需要重启；
   * - **乐观锁**：写内容带 `expectedVersion`，冲突返回 3417。
   */
  aiSkill = {
    /** 列表：分页 + 关键字 / 启用 / 来源筛选 */
    list: (data: AiSkillListDto) =>
      this.post<AppPageQueryResponse<AiSkillModel>>('/ai-skill/list', data),

    /** 详情：元信息 + 文件清单（不含正文） */
    detail: (data: AiSkillKeyDto) => this.post<AiSkillDetailModel>('/ai-skill/detail', data),

    /** 新建（建完默认启用，落盘后立即对模型可见） */
    create: (data: AiSkillCreateDto) => this.post<AiSkillDetailModel>('/ai-skill/create', data),

    /** 更新元信息 / 开关 */
    update: (data: AiSkillUpdateDto) => this.post<AiSkillDetailModel>('/ai-skill/update', data),

    /** 删除（软删 + 删落盘目录） */
    remove: (data: AiSkillKeyDto) => this.post<{ ok: boolean }>('/ai-skill/remove', data),

    /** 读单个文件正文 */
    readFile: (data: AiSkillFileReadDto) =>
      this.post<AiSkillFileContentModel>('/ai-skill/file/read', data),

    /** 写单个文件（新建或覆盖） */
    saveFile: (data: AiSkillFileSaveDto) =>
      this.post<AiSkillDetailModel>('/ai-skill/file/save', data),

    /** 删单个文件（`SKILL.md` 不允许删） */
    removeFile: (data: AiSkillFileRemoveDto) =>
      this.post<AiSkillDetailModel>('/ai-skill/file/remove', data),

    /** 导入预览：这个链接里有哪些技能、哪些已存在 */
    previewImport: (data: AiSkillImportPreviewDto) =>
      this.post<AiSkillImportPreviewResultModel>('/ai-skill/import/preview', data),

    /** 从链接导入（skills.sh / GitHub / 直接 Markdown 链接） */
    import: (data: AiSkillImportDto) =>
      this.post<AiSkillImportResultModel>('/ai-skill/import', data),

    /** 平台技能的授权列表（哪些主体能看见它） */
    listGrants: (data: SkillGrantListDto) =>
      this.post<SkillGrantModel[]>('/ai-skill/grants/list', data),

    /** 覆盖式设置授权：传进来的就是最终集合，`[]` = 收回全部 */
    setGrants: (data: SkillGrantSetDto) =>
      this.post<SkillGrantModel[]>('/ai-skill/grants/set', data),
  }

  /* ========== 长期记忆 ========== */

  aiMemory = {
    /** 列表：分页 + 用户 / 类型 / 来源 / 启停 / 关键字筛选 */
    list: (data: AiMemoryListDto) =>
      this.post<AppPageQueryResponse<AiMemoryModel>>('/ai-memory/list', data),

    /** 更新（内容 / 类型 / 置顶 / 启停；归属与 key 不可改） */
    update: (data: AiMemoryUpdateDto) => this.post<AiMemoryModel>('/ai-memory/update', data),

    /** 软删 */
    remove: (data: AiMemoryRemoveDto) => this.post<{ removed: boolean }>('/ai-memory/remove', data),
  }

  /* ========== 能力服务（后台登记外部 API） ========== */

  capabilityService = {
    /** 列表（不含凭据，只给 hasCredential） */
    list: (data: CapabilityServiceListDto) =>
      this.post<CapabilityServiceModel[]>('/ai-capability/list', data),

    /** 保存 = 登记（source:'manual'） */
    save: (data: CapabilityServiceSaveDto) =>
      this.post<CapabilityServiceModel>('/ai-capability/save', data),

    remove: (data: CapabilityServiceIdDto) =>
      this.post<{ removed: boolean }>('/ai-capability/remove', data),

    status: (data: CapabilityServiceStatusDto) =>
      this.post<{ updated: boolean }>('/ai-capability/status', data),

    /** 只测连通，不登记 */
    test: (data: CapabilityServiceTestDto) =>
      this.post<CapabilityServiceTestResultDto>('/ai-capability/test', data),

    /** 拉对方 `POST /manifest` 的内容，给页面确认 */
    pullManifest: (data: CapabilityServiceTestDto) =>
      this.post<Record<string, unknown>>('/ai-capability/pull-manifest', data),

    /** 从 MCP server 拉工具清单（网关做握手 + tools/list） */
    pullMcp: (data: CapabilityServiceMcpPullDto) =>
      this.post<CapabilityServiceCapabilityDto[]>('/ai-capability/pull-mcp', data),

    /** 服务级授权：全部授权行 */
    listGrants: () => this.post<ServiceGrantModel[]>('/ai-capability/grants/list', {}),

    /** 服务级授权：覆盖式设置某个管理员可用的外部服务/MCP */
    setGrants: (data: ServiceGrantSetDto) =>
      this.post<ServiceGrantModel[]>('/ai-capability/grants/set', data),
  }

  /* ========== 工作区（AI 执行环境） ========== */

  workspace = {
    /** 当前管理员的工作区（含实时运行态） */
    list: () => this.post<WorkspaceModel[]>('/ai-workspace/list', {}),

    create: (data: WorkspaceCreateDto) => this.post<WorkspaceModel>('/ai-workspace/create', data),

    update: (data: WorkspaceUpdateDto) => this.post<WorkspaceModel>('/ai-workspace/update', data),

    remove: (data: WorkspaceIdDto) => this.post<{ removed: boolean }>('/ai-workspace/remove', data),

    /** 拉起容器（desired_status → running） */
    start: (data: WorkspaceIdDto) => this.post<WorkspaceModel>('/ai-workspace/start', data),

    /** 停止容器（desired_status → stopped） */
    stop: (data: WorkspaceIdDto) => this.post<WorkspaceModel>('/ai-workspace/stop', data),
  }

  /* ========== 个人凭据 ========== */

  /**
   * 个人凭据（**管理员鉴权**，设计 `docs/design/workspace-cli-credentials.md` §6.4）。
   *
   * 三条口径：
   * - **值只进不出**：响应里只有 `config`（明文配置）与 `secretHint`（`root` / `AKID…abcd`），
   *   任何角色都取不到明文；
   * - **归属由身份决定**：普通管理员 / 用户只看自己的，超管可看全部元数据；
   * - **改映射不改值**：改 `inject` 走 `updateInject`，改值必须重新绑定（AAD 与字段绑定）。
   */
  aiCredential = {
    /** 列表：当前身份可见的凭据（超管为全部元数据） */
    list: (data: CredentialListDto = {}) =>
      this.post<CredentialModel[]>('/ai-credential/list', data),

    /** 详情（同样不含明文） */
    detail: (data: CredentialIdDto) => this.post<CredentialModel>('/ai-credential/detail', data),

    /** 绑定：字段值由模板采集，服务端按模板校验后加密入库 */
    create: (data: CredentialBindDto) => this.post<CredentialModel>('/ai-credential/create', data),

    /** 修改注入映射（文件 / 环境变量规则） */
    updateInject: (data: CredentialUpdateInjectDto) =>
      this.post<CredentialModel>('/ai-credential/update-inject', data),

    /** 吊销（置 revoked 并软删；容器内的旧文件由同步流程删除） */
    remove: (data: CredentialIdDto) =>
      this.post<{ removed: boolean }>('/ai-credential/remove', data),
  }

  /* ========== AI 市场 ========== */

  /**
   * AI 市场（**管理员鉴权**，v1 只做 MCP 区）：
   * 市场只准备"声明"，不装二进制、不启容器；市场不是白名单。
   */
  aiMarket = {
    list: (data: MarketItemListDto = {}) => this.post<MarketItemModel[]>('/ai-market/list', data),

    /** 收录 / 更新一条 MCP 条目（key 幂等） */
    save: (data: MarketItemSaveDto) => this.post<MarketItemModel>('/ai-market/save', data),

    remove: (data: MarketItemKeyDto) => this.post<{ removed: boolean }>('/ai-market/remove', data),
  }

  /* ========== 登录设备（会话） ========== */

  session = {
    /** 需要登录态（前台用户或管理员）：当前身份的全部登录设备（含 current 标记） */
    list: () => this.post<SessionListModel>('/session/list'),

    /** 需要登录态：按会话 id 下线某台设备（幂等：已失效也返回成功） */
    remove: (data: RemoveSessionDto) => this.post<SuccessResultModel>('/session/remove', data),
  }
}
