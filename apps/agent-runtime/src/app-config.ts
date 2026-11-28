import { z } from 'zod'
import {
  AppConfigFacade,
  DbConfigSchema,
  envConfigLoader,
  KafkaConfigSchema,
  LarkConfigSchema,
  LoggerConfigSchema,
  NotifyConfigSchema,
  RedisConfigSchema,
  StorageConfigSchema,
  WorkspaceConfigSchema,
} from '@repo/kits'
import { MonitorConfigSchema } from '@repo/monitor'

/**
 * 服务端应用配置 schema。
 *
 * 设计：**直接复用 kits 各模块的配置 schema** 组合成整份应用配置 ——
 * 单一事实源，一处校验 + 补默认值；落到各模块时只需 `ConfigService.get('<namespace>')`。
 * 不含 `db.entities`（类引用无法来自环境变量），由组合根在装配 `DbModule` 时补上。
 */
export const serverAppConfigSchema = z.object({
  /** 应用级业务配置（ServerConfig 命名空间） */
  server: z
    .object({
      /** HTTP 服务端口 */
      port: z.coerce.number().int().positive().default(9989),
      /**
       * 空闲长连接保持时长（ms），映射到 Node `server.keepAliveTimeout`。
       *
       * 默认 75s 的来由：前置网关（如 Kong）的上游连接池默认
       * `upstream_keepalive_idle_timeout = 60s`，而它**不认**后端响应头里的
       * `Keep-Alive: timeout=N` 提示。若后端比网关先关空闲连接，网关就会在
       * 「它以为还能复用」的窗口里往一个正在关闭的 socket 发请求 →
       * 间歇性 502 / `upstream prematurely closed connection`（且后端日志无痕，
       * 因为请求根本没到应用）。故后端必须比网关的上游空闲超时**更长**。
       */
      keepAliveTimeoutMs: z.coerce.number().int().positive().default(75_000),
      /**
       * 收完请求头的最长等待（ms），映射到 Node `server.headersTimeout`。
       *
       * **必须大于 `keepAliveTimeoutMs`**：否则长连接在被复用的瞬间可能因等待
       * 请求头超时而被销毁。注意 Node 对「headersTimeout ≤ keepAliveTimeout」
       * **不报错、静默接受**（实测确认），所以这里用 superRefine 显式拦住。
       */
      headersTimeoutMs: z.coerce.number().int().positive().default(80_000),
      /**
       * 部署版本标识（构建 / 发布时注入，如 git sha、镜像 tag），默认 `dev`。
       *
       * 只用于运维核对：`GET /info` 暴露它，滚动更新后确认线上实际跑的是哪个构建
       * （否则「更新了却没生效」只能靠猜）。
       */
      appVersion: z.string().default('dev'),
      /**
       * 优雅关闭的总期限（ms）：`SIGTERM` 后最多等这么久排空在途请求，超时强制退出。
       *
       * 关闭顺序（Nest `app.close()`）：`beforeApplicationShutdown`（SSE Hub 排空长连接）→
       * `httpServer.close()`（等在途请求自然结束）→ 各资源 `onApplicationShutdown`。
       * 默认 25s：**必须小于 k8s 的 `terminationGracePeriodSeconds` 减去 preStop 耗时**
       * （推荐 grace 60s + preStop 8s，25s 有充裕余量）。超时强制退出的意义是——
       * 与其卡死到被 SIGKILL（连一行原因都留不下），不如自己记录并退出。
       */
      shutdownTimeoutMs: z.coerce.number().int().positive().default(25_000),
    })
    .superRefine((value, ctx) => {
      if (value.headersTimeoutMs <= value.keepAliveTimeoutMs) {
        ctx.addIssue({
          code: 'custom',
          path: ['headersTimeoutMs'],
          message:
            `headersTimeoutMs(${value.headersTimeoutMs}) 必须大于 ` +
            `keepAliveTimeoutMs(${value.keepAliveTimeoutMs})，` +
            '否则长连接被复用时可能因等待请求头超时被销毁',
        })
      }
    }),
  db: DbConfigSchema,
  redis: RedisConfigSchema,
  storage: StorageConfigSchema,
  logger: LoggerConfigSchema,
  notify: NotifyConfigSchema,
  /** 告警业务配置（MonitorConfig 命名空间；schema 唯一来源在 @repo/monitor） */
  monitor: MonitorConfigSchema,
  /** 飞书应用凭据：未配置则不装配 LarkModule */
  lark: LarkConfigSchema.optional(),
  /** Kafka：未配置 brokers 则不装配 KafkaModule */
  kafka: KafkaConfigSchema.optional(),
  /**
   * 工作区运行时（执行环境 = 沙箱 / 非沙箱）：只放**部署边界**，
   * 用户选哪个在工具配置 `bash.execution` 里（见 `docs/design/workspace-runtime.md`）。
   */
  workspace: WorkspaceConfigSchema,
  /**
   * AI Agent 业务配置（AgentConfig 命名空间，见 modules/ai/core/config.ts）。
   *
   * 恒存在（不像 lark / kafka 那样整体可选）：运行时旋钮缺省即用默认值；
   * 模型不在这里配（统一经 model-gateway 目录解析）。
   */
  agent: z.object({
    // ── 技能目录（机制见 docs/design/ai-agent.md §1.4）──
    // 宿主技能目录来源已删除（P9）：技能只来自「随包 catalog + 技能库落盘投影」。
    /**
     * 技能库的落盘目录（后台在线编辑 / 从 skills.sh、GitHub 链接导入 / agent 写入的技能都落到这里）。
     *
     * **这个目录由我们独占**：启动时会清掉库里不存在的技能目录。它是数据库的投影，
     * 宿主技能目录来源已在 P9 删除。
     */
    skillsLibraryDir: z.string().default('~/.billy/skills'),
    // ── 上下文策略（详见 docs/design/ai-agent.md §3.9）──
    /** 触发线：估算用量超过「模型窗口 × 本比例」就开始裁剪/压缩 */
    contextTriggerRatio: z.coerce.number().positive().max(1).default(0.7),
    /** 裁剪目标：裁到「窗口 × 本比例」为止 */
    contextTrimTargetRatio: z.coerce.number().positive().max(1).default(0.5),
    /** 压缩目标：摘要后到「窗口 × 本比例」为止 */
    /** 最近几轮永不裁（保底能正常对话） */
    contextKeepRecentTurns: z.coerce.number().int().positive().default(3),
    /** 单条工具结果给模型的视图上限（相对窗口；落库仍是完整原文） */
    contextToolResultMaxRatio: z.coerce.number().positive().max(1).default(0.1),
    /**
     * 一轮之内**所有工具结果**给模型的累计上限（相对窗口；落库仍是完整原文）。
     *
     * 单条上限按窗口线性放大，1M 窗口下等于"不裁"；真正决定上下文暴涨的是
     * 「调用次数 × 每条多大」，所以需要一条累计预算（见 docs/design/ai-agent.md §3.9）。
     */
    contextToolResultTotalRatio: z.coerce.number().positive().max(1).default(0.3),
    /** 未知模型的保守窗口（tokenlens 查不到时用；会打 warn 日志） */
    contextFallbackWindow: z.coerce.number().int().positive().default(32_000),
    /** 按模型覆盖窗口：`provider/model=65536,其它=32768`（最高优先） */
    contextModelWindows: z.record(z.string(), z.coerce.number().int().positive()).default({}),
    // ── 可恢复执行与看门狗（设计文档 §3.13）──
    /** 是否开启可恢复执行（durable）：开启后逐步落快照，崩溃后可从快照续跑（会重放/重跑，真花钱） */
    durableEnabled: z.boolean().default(true),
    /**
     * 是否启用引擎 v2 执行路径（RunExecutor → AgentLoop → 能力接缝）。
     *
     * 默认开启：v2 与旧路径复用同一份执行体，wire format 不变；灰度期可用
     * `AGENT_ENGINE_V2=false` 一键回退。
     */
    engineV2: z.boolean().default(true),
    /** 心跳超时（ms）：超过就认为这一轮已经没人管了（崩溃或卡死） */
    heartbeatTimeoutMs: z.coerce.number().int().positive().default(60_000),
    /**
     * 单轮总时长上限（ms）：**0 = 不限制**（默认）。
     *
     * 长任务（多子 agent / 长工具往返）不该被墙钟一刀切；"进程还活着吗"交给心跳，
     * "卡住不吐字"交给 `firstTokenTimeoutMs`。需要硬上限的部署再显式配环境变量。
     */
    runTimeoutMs: z.coerce.number().int().nonnegative().default(0),
    /**
     * 首 token 超时（ms）：从发起模型调用到**第一段输出**之间没有任何动静就判失败。
     *
     * 与 `runTimeoutMs`（总时长，默认不限）是两件事：这条防"卡住不吐字"。
     * 设为 0 表示关闭（完全交给总时长兜底）。
     */
    firstTokenTimeoutMs: z.coerce.number().int().nonnegative().default(120_000),
    /** 看门狗扫描间隔（ms） */
    watchdogIntervalMs: z.coerce.number().int().positive().default(30_000),
    /** 是否多实例部署：true 时要求配置 Redis（断线补发 / 停止 / 恢复租约都依赖它） */
    multiInstance: z.boolean().default(false),
    // ── 子 agent（设计文档 §3.14.7）──
    /** 同一父 run 下允许创建的子 agent 个数上限（超出把"配额已满"作为工具结论返回，不炸整轮） */
    subAgentMaxPerRun: z.coerce.number().int().positive().default(4),
    /** 子 agent 深度上限（当前工具面已保证为 1，留配置位给将来） */
    subAgentMaxDepth: z.coerce.number().int().positive().default(1),
    /** 单个子 agent 的步数上限（0 = 沿用 AGENT_MAX_STEPS） */
    subAgentMaxSteps: z.coerce.number().int().nonnegative().default(0),
    /** 单个子 agent 的墙钟上限（ms；0 = 沿用 runTimeoutMs；都为 0 = 不限） */
    subAgentTimeoutMs: z.coerce.number().int().nonnegative().default(0),
    // ── 工作区根（文件物化 + 工作区路径；命令执行在 workspace-service）──
    /** 命令的工作根目录（缺省 = 服务进程工作目录）；agent 只能在这个目录之内指定 cwd */
    commandWorkDir: z.string().optional(),
    // ── 文件管理（文件元数据物化的部署上限）──
    /** 单文件硬上限（字节） */
    fileMaxBytes: z.coerce.number().int().positive().optional(),
    /** 单会话文件数硬上限 */
    fileMaxFiles: z.coerce.number().int().positive().optional(),
    /** 单会话总字节硬上限 */
    fileMaxTotalBytes: z.coerce.number().int().positive().optional(),
    /** read-file / replace 的读取上限 */
    fileReadMaxBytes: z.coerce.number().int().positive().optional(),
    /** 单页最多行数 / 字符数 */
    filePageLinesMax: z.coerce.number().int().positive().optional(),
    filePageCharsMax: z.coerce.number().int().positive().optional(),
    /** 单次写入 / 替换 / 追加的内容上限 */
    fileWriteMaxBytes: z.coerce.number().int().positive().optional(),
    /** file-search 的扫描文件数 / 字节 / 结果上限 */
    fileSearchMaxFiles: z.coerce.number().int().positive().optional(),
    fileSearchMaxBytes: z.coerce.number().int().positive().optional(),
    fileSearchMaxResults: z.coerce.number().int().positive().optional(),
    /** workspace-files 的文件数 / 深度上限 */
    fileWorkspaceMaxFiles: z.coerce.number().int().positive().optional(),
    fileWorkspaceMaxDepth: z.coerce.number().int().positive().optional(),
    // ── 工具引擎（设计 ai-agent-tool-engine.md §5.5 / §5.6）──
    /**
     * 单次给模型的工具出参上限（字节）**硬上限**。
     *
     * 工具的分页阈值可以在后台按工具改，但改不出这个上限 —— DB 被改坏也突破不了部署边界。
     */
    toolPageBytesMax: z.coerce
      .number()
      .int()
      .positive()
      .default(8 * 1024),
    /** 每轮取页次数**硬上限**（防模型反复取页烧 token） */
    toolMaxPagesPerTurnMax: z.coerce.number().int().positive().default(5),
  }),
  /**
   * model-gateway（模型网关）连接配置。
   *
   * runtime 只向网关要目录、只把模型实例指向网关，**不再读任何供应商 key / 配置表**。
   */
  modelGateway: z.object({
    url: z.string().min(1).default('http://127.0.0.1:9992'),
    /** runtime ↔ 网关的内部令牌（`MODEL_INTERNAL_TOKEN`） */
    token: z.string().default(''),
    timeoutMs: z.coerce.number().int().positive().default(60_000),
  }),
})

export type ServerAppConfig = z.infer<typeof serverAppConfigSchema>

/** 空串视为未配置（env 常见写法 `KEY=`） */
/** 沙箱开关：新键 `AGENT_WORKSPACE_SANDBOX`（true/false）；旧键 `AGENT_WORKSPACE_MODE=off` 兼容 */
const parseSandbox = (env: NodeJS.ProcessEnv): boolean | undefined => {
  const raw = env.AGENT_WORKSPACE_SANDBOX?.trim()
  if (raw) return !['false', '0', 'off', 'no'].includes(raw.toLowerCase())
  const legacy = env.AGENT_WORKSPACE_MODE?.trim()
  if (!legacy) return undefined
  return legacy !== 'off'
}

const optional = (value: string | undefined): string | undefined => (value ? value : undefined)

const optionalNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined
}

const parseBoolean = (value: string | undefined): boolean | undefined =>
  value === undefined ? undefined : value === 'true'

/** 解析 `key=number,key=number`（用于按模型覆盖上下文窗口） */
const parseKeyValueNumbers = (value: string | undefined): Record<string, number> | undefined => {
  if (!value) return undefined
  const result: Record<string, number> = {}
  for (const pair of value.split(',')) {
    const [key, raw] = pair.split('=')
    const parsed = Number(raw)
    if (key?.trim() && Number.isFinite(parsed) && parsed > 0) {
      result[key.trim()] = Math.trunc(parsed)
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * 环境变量 → 嵌套配置。未设置的键留 `undefined`，由 schema 默认值兜底。
 */
export const mapServerEnv = (env: NodeJS.ProcessEnv): Record<string, unknown> => ({
  server: {
    port: optional(env.PORT),
    keepAliveTimeoutMs: optional(env.KEEP_ALIVE_TIMEOUT_MS),
    headersTimeoutMs: optional(env.HEADERS_TIMEOUT_MS),
    appVersion: optional(env.APP_VERSION),
    shutdownTimeoutMs: optional(env.SHUTDOWN_TIMEOUT_MS),
  },
  db: {
    url: optional(env.DB_URL),
    sync: parseBoolean(env.DB_SYNC),
    poolSize: optional(env.DB_POOL_SIZE),
  },
  redis: {
    url: optional(env.REDIS_URL),
    keyPrefix: optional(env.REDIS_KEY_PREFIX),
  },
  storage: {
    provider: optional(env.OBJECT_STORAGE_PROVIDER),
    region: optional(env.OBJECT_STORAGE_REGION),
    bucket: optional(env.OBJECT_STORAGE_BUCKET),
    accessKeyId: optional(env.OBJECT_STORAGE_ACCESS_KEY_ID),
    secretAccessKey: optional(env.OBJECT_STORAGE_SECRET_ACCESS_KEY),
    endpoint: optional(env.OBJECT_STORAGE_ENDPOINT),
  },
  logger: {
    prefix: 'server',
    level: optional(env.LOG_LEVEL),
    pretty: env.NODE_ENV === undefined ? undefined : env.NODE_ENV !== 'production',
    loki: env.LOKI_HOST
      ? { host: env.LOKI_HOST, labels: { env: env.NODE_ENV ?? 'local' } }
      : undefined,
  },
  monitor: {
    enabled: env.ALERT_ENABLED === undefined ? undefined : env.ALERT_ENABLED !== 'false',
    emailTo: optional(env.ALERT_EMAIL_TO),
    instanceId: optional(env.MONITOR_INSTANCE_ID),
    retentionDays: optionalNumber(env.MONITOR_SAMPLE_RETENTION_DAYS),
  },
  notify: {
    lark: env.LARK_NOTIFY_RECEIVE_ID
      ? {
          receiveId: env.LARK_NOTIFY_RECEIVE_ID,
          receiveIdType: optional(env.LARK_NOTIFY_RECEIVE_ID_TYPE),
        }
      : undefined,
    email: env.ALERT_SMTP_HOST
      ? {
          host: env.ALERT_SMTP_HOST,
          port: optional(env.ALERT_SMTP_PORT),
          secure:
            env.ALERT_SMTP_SECURE === undefined ? undefined : env.ALERT_SMTP_SECURE !== 'false',
          user: optional(env.ALERT_SMTP_USER),
          pass: optional(env.ALERT_SMTP_PASS),
          from: env.ALERT_SMTP_FROM ?? '',
        }
      : undefined,
  },
  lark:
    env.LARK_APP_ID && env.LARK_APP_SECRET
      ? {
          appId: env.LARK_APP_ID,
          appSecret: env.LARK_APP_SECRET,
          domain: optional(env.LARK_DOMAIN),
        }
      : undefined,
  kafka: env.KAFKA_BROKERS
    ? {
        brokers: env.KAFKA_BROKERS,
        clientId: optional(env.KAFKA_CLIENT_ID),
        topicPrefix: optional(env.KAFKA_TOPIC_PREFIX),
        groupIdPrefix: optional(env.KAFKA_GROUP_ID_PREFIX),
        // 快失败相关（不填走 kits 默认：3s / 15s / 2 次 / 300ms / 5s 冷却）
        connectionTimeoutMs: optional(env.KAFKA_CONNECTION_TIMEOUT_MS),
        requestTimeoutMs: optional(env.KAFKA_REQUEST_TIMEOUT_MS),
        retryCount: optional(env.KAFKA_RETRY_COUNT),
        retryInitialDelayMs: optional(env.KAFKA_RETRY_INITIAL_DELAY_MS),
        unavailableCooldownMs: optional(env.KAFKA_UNAVAILABLE_COOLDOWN_MS),
      }
    : undefined,
  workspace: {
    sandbox: parseSandbox(env),
    sandboxNetwork: optional(env.AGENT_WORKSPACE_SANDBOX_NETWORK),
    probeTimeoutMs: optionalNumber(env.AGENT_WORKSPACE_PROBE_TIMEOUT_MS),
  },
  agent: {
    ...(env.AGENT_SKILLS_LIBRARY_DIR ? { skillsLibraryDir: env.AGENT_SKILLS_LIBRARY_DIR } : {}),
    contextTriggerRatio: optional(env.AGENT_CONTEXT_TRIGGER_RATIO),
    contextTrimTargetRatio: optional(env.AGENT_CONTEXT_TRIM_TARGET_RATIO),
    contextKeepRecentTurns: optional(env.AGENT_CONTEXT_KEEP_RECENT_TURNS),
    contextToolResultMaxRatio: optional(env.AGENT_CONTEXT_TOOL_RESULT_MAX_RATIO),
    contextToolResultTotalRatio: optional(env.AGENT_CONTEXT_TOOL_RESULT_TOTAL_RATIO),
    contextFallbackWindow: optional(env.AGENT_CONTEXT_FALLBACK_WINDOW),
    contextModelWindows: parseKeyValueNumbers(env.AGENT_CONTEXT_MODEL_WINDOWS),
    durableEnabled:
      env.AGENT_DURABLE_ENABLED === undefined ? undefined : env.AGENT_DURABLE_ENABLED !== 'false',
    engineV2: env.AGENT_ENGINE_V2 === undefined ? undefined : env.AGENT_ENGINE_V2 !== 'false',
    heartbeatTimeoutMs: optional(env.AGENT_HEARTBEAT_TIMEOUT_MS),
    runTimeoutMs: optional(env.AGENT_RUN_TIMEOUT_MS),
    firstTokenTimeoutMs: optional(env.AGENT_FIRST_TOKEN_TIMEOUT_MS),
    watchdogIntervalMs: optional(env.AGENT_WATCHDOG_INTERVAL_MS),
    multiInstance: parseBoolean(env.AGENT_MULTI_INSTANCE),
    subAgentMaxPerRun: optional(env.AGENT_SUB_AGENT_MAX_PER_RUN),
    subAgentMaxDepth: optional(env.AGENT_SUB_AGENT_MAX_DEPTH),
    subAgentMaxSteps: optional(env.AGENT_SUB_AGENT_MAX_STEPS),
    subAgentTimeoutMs: optional(env.AGENT_SUB_AGENT_TIMEOUT_MS),
    commandWorkDir: optional(env.AGENT_COMMAND_WORK_DIR),
    fileMaxBytes: optional(env.AGENT_FILE_MAX_BYTES),
    fileMaxFiles: optional(env.AGENT_FILE_MAX_FILES),
    fileMaxTotalBytes: optional(env.AGENT_FILE_MAX_TOTAL_BYTES),
    fileReadMaxBytes: optional(env.AGENT_FILE_READ_MAX_BYTES),
    filePageLinesMax: optional(env.AGENT_FILE_PAGE_LINES_MAX),
    filePageCharsMax: optional(env.AGENT_FILE_PAGE_CHARS_MAX),
    fileWriteMaxBytes: optional(env.AGENT_FILE_WRITE_MAX_BYTES),
    fileSearchMaxFiles: optional(env.AGENT_FILE_SEARCH_MAX_FILES),
    fileSearchMaxBytes: optional(env.AGENT_FILE_SEARCH_MAX_BYTES),
    fileSearchMaxResults: optional(env.AGENT_FILE_SEARCH_MAX_RESULTS),
    fileWorkspaceMaxFiles: optional(env.AGENT_FILE_WORKSPACE_MAX_FILES),
    fileWorkspaceMaxDepth: optional(env.AGENT_FILE_WORKSPACE_MAX_DEPTH),
    toolPageBytesMax: optional(env.AGENT_TOOL_PAGE_BYTES_MAX),
    toolMaxPagesPerTurnMax: optional(env.AGENT_TOOL_MAX_PAGES_PER_TURN),
  },
  workspaceService: {
    url: optional(env.WORKSPACE_SERVICE_URL),
    token: optional(env.WORKSPACE_INTERNAL_TOKEN) ?? optional(env.TOOL_INTERNAL_TOKEN),
    timeoutMs: optional(env.WORKSPACE_SERVICE_TIMEOUT_MS),
  },
  modelGateway: {
    url: optional(env.MODEL_GATEWAY_URL),
    token: optional(env.MODEL_GATEWAY_TOKEN),
    timeoutMs: optional(env.MODEL_GATEWAY_TIMEOUT_MS),
  },
})

/**
 * 加载并缓存服务端配置。**必须在 `NestFactory.create` 之前调用**：
 * 各模块的 `forRootAsync` 工厂是惰性的，但都要读到已加载的配置。
 */
export const loadServerAppConfig = (): Promise<ServerAppConfig> =>
  AppConfigFacade.initial({
    schema: serverAppConfigSchema,
    // 换来源只改这一行（如 `loader: 'consul', loaderOptions: { baseURL, key }`），shape 不变
    loader: envConfigLoader({ envFileName: '.env', mapEnv: mapServerEnv }),
  })
