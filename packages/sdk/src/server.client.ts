import {
  AiAvailableModelListModel,
  AiConnectorActionResult,
  AiConnectorCatalogEntry,
  AiConnectorCreateDto,
  AiConnectorDetail,
  AiConnectorIdDto,
  AiConnectorListDto,
  AiConnectorModel,
  AiConnectorUpdateDto,
  AiModelCreateDto,
  AiModelIdDto,
  AiModelListDto,
  AiModelModel,
  AiModelUpdateDto,
  AiProviderCreateDto,
  AiProviderIdDto,
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
  AiSkillListDto,
  AiSkillModel,
  AiSkillUpdateDto,
  AiToolKeyDto,
  AiToolListDto,
  AiToolModel,
  AiToolUpdateDto,
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
  CreateUserDto,
  ForgotPasswordDto,
  GetAdminDetailDto,
  GetStorageDownloadUrlDto,
  GetStorageUploadPresignedUrlDto,
  GetUserDetailDto,
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
  AgentFilePreviewModel,
  AgentWorkspaceListModel,
  AgentConversationRenameDto,
  AgentInstructionsDto,
  AgentInstructionsModel,
  AgentListModel,
  AgentRunDetailModel,
  AgentRunIdDto,
  AgentRunListDto,
  AgentRunModel,
  AgentRunStopDto,
  AgentRunStopResultModel,
  AgentStatusModel,
  AgentTimelineItemModel,
  AgentTimelineListDto,
  AgentUsageSummaryModel,
  AgentUsageSummaryQueryDto,
  AgentUsageRangeDto,
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

/** 建流路由：响应体是 AI SDK v6 的 UI Message Stream（**不套业务信封**） */
const AGENT_CHAT_STREAM_PATH = '/agent/chat/stream'

/** 续流路由：`GET ...?offset=N`，无进行中的流时服务端回 204（AI SDK 续传约定） */
const agentResumeStreamPath = (runId: string): string =>
  `/agent/run/${encodeURIComponent(runId)}/stream`

export class ServerClient extends HttpClient<BearerTokenCredentials> {
  /** SSE 长连接复用的凭证（与普通请求同一份，避免「HTTP 认证了、推流没认证」） */
  private readonly streamCredentials: CredentialsManager<BearerTokenCredentials>
  /** SSE 订阅地址：完整 URL（客户端不做 baseUrl 拼接，故在构造期算好） */
  private readonly streamUrl: string
  /** 规范化后的 baseUrl（无尾斜杠）：给 AI SDK transport 拼完整 URL 用 */
  private readonly agentBaseUrl: string

  constructor(
    options: Omit<HttpClientOptions<BearerTokenCredentials>, 'authStrategy'>,
  ) {
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
      definitions: () =>
        this.post<MonitorRuleDefinitionModel[]>('/monitor/rule/definitions', {}),

      list: (data: ListMonitorRuleDto) =>
        this.post<MonitorRuleModel[]>('/monitor/rule/list', data),

      update: (data: UpdateMonitorRuleDto) =>
        this.post<MonitorRuleModel>('/monitor/rule/update', data),

      reset: (data: ResetMonitorRuleDto) =>
        this.post<MonitorRuleModel>('/monitor/rule/reset', data),
    },

    alert: {
      pageQuery: (data: PageQueryMonitorAlertDto) =>
        this.post<AppPageQueryResponse<MonitorAlertModel>>(
          '/monitor/alert/page-query',
          data,
        ),

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
      status: () =>
        this.post<MonitorEngineStatusModel>('/monitor/engine/status', {}),
    },

    log: {
      pageQuery: (data: PageQueryMonitorLogDto) =>
        this.post<AppPageQueryResponse<MonitorAlertDeliveryModel>>(
          '/monitor/log/page-query',
          data,
        ),
    },

    test: (data: TestAlertDto) =>
      this.post<SuccessResultModel>('/monitor/test', data),

    health: () =>
      this.post<MonitorHealthModel>('/monitor/health', undefined, { skipAuth: true }),
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
    chat: (data: AgentChatDto) =>
      this.post<AgentChatResultModel>('/agent/chat', data),

    /** 停止某一轮（幂等；跨副本时服务端内部广播，前端无需关心） */
    stopRun: (data: AgentRunStopDto) =>
      this.post<AgentRunStopResultModel>('/agent/run/stop', data),

    conversation: {
      /** 新建会话（省略 agentKey 用默认 agent） */
      create: (data: AgentConversationCreateDto) =>
        this.post<AgentConversationModel>('/agent/conversation/create', data),

      /** 会话分页（按最近活跃排序） */
      list: (data: AgentConversationListDto) =>
        this.post<AppPageQueryResponse<AgentConversationModel>>(
          '/agent/conversation/list',
          data,
        ),

      detail: (data: AgentConversationIdDto) =>
        this.post<AgentConversationModel>('/agent/conversation/detail', data),

      /** 重命名会话（用户手动改名；空标题 / 超长由服务端数据结构拦下） */
      rename: (data: AgentConversationRenameDto) =>
        this.post<AgentConversationModel>('/agent/conversation/rename', data),

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

      preview: (data: {
        conversationId: string
        path: string
        source?: 'ai' | 'workspace'
      }) => this.post<AgentFilePreviewModel>('/agent/file/preview', data),

      /** 后台独立文件页：全量列表（管理员） */
      adminList: (data: AgentFileAdminListDto) =>
        this.post<AgentFileAdminListModel>('/agent/file/admin/list', data),

      /** 后台独立文件页：总量统计（管理员） */
      adminStats: (data: AgentFileAdminStatsDto) =>
        this.post<AgentFileAdminStatsModel>('/agent/file/admin/stats', data),

      /** 后台独立文件页：文本预览（管理员；任意会话） */
      adminPreview: (data: AgentFileAdminPreviewDto) =>
        this.post<AgentFilePreviewModel>('/agent/file/admin/preview', data),

      workspaceContentUrl: (data: {
        conversationId: string
        path: string
        download?: boolean
      }) => {
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
      detail: (data: AgentRunIdDto) =>
        this.post<AgentRunDetailModel>('/agent/run/detail', data),
    },

    /**
     * 本轮可选的模型清单（**只有"供应商启用 + 模型启用"的**）。
     *
     * 会话页的选择器用它渲染；`defaultModelId` 就是未选择时用的那个（库空时为 null →
     * 前端应当提示"先去后台配模型"）。
     */
    models: () => this.post<AiAvailableModelListModel>('/agent/models'),

    timeline: {
      /** 时间线分页（消息 / 推理 / 工具调用与结果 / 步骤 / 计划 / 摘要…） */
      list: (data: AgentTimelineListDto) =>
        this.post<AppPageQueryResponse<AgentTimelineItemModel>>(
          '/agent/timeline/list',
          data,
        ),
    },

    /** 控制台「AI 用量」汇总（管理员）：近 N 天 token / 轮数 / 成功率 / 分模型与 agent */
    usageSummary: (data: AgentUsageSummaryQueryDto) =>
      this.post<AgentUsageSummaryModel>('/agent/usage/summary', data),

    /** 手动回填 AI 用量日表（管理员） */
    usageRollup: (data: AgentUsageRangeDto) =>
      this.post<{ days: number }>('/agent/usage/rollup', data),

    /** POST 建流地址（交给 AI SDK transport 的 `api`） */
    chatStreamUrl: (): string => `${this.agentBaseUrl}${AGENT_CHAT_STREAM_PATH}`,

    /** POST 续跑地址（回答 `ask-user-questions` 的挂起；响应同样是 SSE） */
    chatResumeUrl: (): string => `${this.agentBaseUrl}/agent/chat/resume`,

    /** GET 续流地址（知道 runId 时用；交给 AI SDK transport 的 `prepareReconnectToStreamRequest`） */
    resumeStreamUrl: (runId: string, offset = 0): string =>
      `${this.agentBaseUrl}${agentResumeStreamPath(runId)}?offset=${offset}`,

    /**
     * GET 续流地址（**不知道 runId 时用**）：服务端按登录用户找当前进行中的那一轮，
     * 没有就回 204。`useChat({ resume: true })` 挂载时该用它 —— 刷新 / 换设备都能接回，
     * 且不会在"没有进行中的流"时打到只收 POST 的建流路由（那会 404）。
     */
    currentRunStreamUrl: (offset = 0): string =>
      `${this.agentBaseUrl}/agent/run/stream?offset=${offset}`,

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
    },

    model: {
      list: (data: AiModelListDto) =>
        this.post<AppPageQueryResponse<AiModelModel>>('/ai-model/model/list', data),

      /** 手工新增（自建网关拉不全 / 想手填窗口时用） */
      create: (data: AiModelCreateDto) =>
        this.post<AiModelModel>('/ai-model/model/create', data),

      update: (data: AiModelUpdateDto) =>
        this.post<AiModelModel>('/ai-model/model/update', data),

      remove: (data: AiModelIdDto) =>
        this.post<SuccessResultModel>('/ai-model/model/remove', data),
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
    detail: (data: AiSkillKeyDto) =>
      this.post<AiSkillDetailModel>('/ai-skill/detail', data),

    /** 新建（建完默认启用，落盘后立即对模型可见） */
    create: (data: AiSkillCreateDto) =>
      this.post<AiSkillDetailModel>('/ai-skill/create', data),

    /** 更新元信息 / 开关 */
    update: (data: AiSkillUpdateDto) =>
      this.post<AiSkillDetailModel>('/ai-skill/update', data),

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
  }

  /* ========== 连接器（外部能力来源） ========== */

  aiConnector = {
    /** 型号目录（卡片与表单字段都由它渲染） */
    catalog: () => this.post<AiConnectorCatalogEntry[]>('/ai-connector/catalog'),

    /** 列表 */
    list: (data: AiConnectorListDto) =>
      this.post<AppPageQueryResponse<AiConnectorModel>>('/ai-connector/list', data),

    /** 新建实例 */
    create: (data: AiConnectorCreateDto) =>
      this.post<AiConnectorModel>('/ai-connector/create', data),

    /** 更新（省略的字段 = 不改；密钥给空串 = 清空） */
    update: (data: AiConnectorUpdateDto) =>
      this.post<AiConnectorModel>('/ai-connector/update', data),

    /** 详情（含它产出的工具） */
    detail: (data: AiConnectorIdDto) =>
      this.post<AiConnectorDetail>('/ai-connector/detail', data),

    /** 测试连接（只写状态，不动工具） */
    test: (data: AiConnectorIdDto) =>
      this.post<AiConnectorActionResult>('/ai-connector/test', data),

    /** 同步：列能力 → 写工具 → 注册进注册机 */
    sync: (data: AiConnectorIdDto) =>
      this.post<AiConnectorActionResult>('/ai-connector/sync', data),

    /** 删除（软删；工具行保留并停用） */
    remove: (data: AiConnectorIdDto) => this.post<{ ok: boolean }>('/ai-connector/remove', data),
  }

  /* ========== 登录设备（会话） ========== */

  session = {
    /** 需要登录态（前台用户或管理员）：当前身份的全部登录设备（含 current 标记） */
    list: () => this.post<SessionListModel>('/session/list'),

    /** 需要登录态：按会话 id 下线某台设备（幂等：已失效也返回成功） */
    remove: (data: RemoveSessionDto) =>
      this.post<SuccessResultModel>('/session/remove', data),
  }
}
