import { z } from 'zod'
import {
  AppConfigFacade,
  DbConfigSchema,
  envConfigLoader,
  JwtConfigSchema,
  KafkaConfigSchema,
  LarkConfigSchema,
  LoggerConfigSchema,
  NotifyConfigSchema,
  PasswordConfigSchema,
  RedisConfigSchema,
  StorageConfigSchema,
} from '@repo/kits'

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
      /** 用户体系开关：false 时关闭前台 / 后台两套鉴权，守卫直接放行 */
      authEnabled: z.boolean().default(true),
      /** 找回密码 token 有效期（分钟） */
      resetPasswordTokenTtlMinutes: z.coerce.number().int().positive().default(30),
      /** 限流豁免白名单（精确 IP / IPv4 CIDR） */
      rateLimitWhitelist: z.array(z.string()).default([]),
      /** 是否信任代理转发头（x-forwarded-for） */
      rateLimitTrustProxy: z.boolean().default(false),
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
  jwt: JwtConfigSchema,
  password: PasswordConfigSchema,
  storage: StorageConfigSchema,
  logger: LoggerConfigSchema,
  notify: NotifyConfigSchema,
  /** 告警业务配置（MonitorConfig 命名空间） */
  monitor: z.object({
    /** 告警总开关：false 时 notifyError 直接跳过 */
    enabled: z.boolean().default(true),
    /** 邮件告警默认接收人（email 通道的 to） */
    emailTo: z.string().optional(),
    /** 实例标识；缺省用 hostname:pid */
    instanceId: z.string().optional(),
    /** 指标样本保留天数 */
    retentionDays: z.number().int().positive().default(30),
  }),
  /** 飞书应用凭据：未配置则不装配 LarkModule */
  lark: LarkConfigSchema.optional(),
  /** Kafka：未配置 brokers 则不装配 KafkaModule */
  kafka: KafkaConfigSchema.optional(),
  /**
   * AI Agent 业务配置（AgentConfig 命名空间，见 modules/ai/core/config.ts）。
   *
   * 恒存在（不像 lark / kafka 那样整体可选）：模型与密钥缺任意一个都只是「能力不可用」，
   * `/agent/*` 返回 3301 并保留其余功能；这样前端能拿到确定的状态结构而不是 404。
   */
  agent: z.object({
    /** 默认模型标识（`provider/model`，如 `deepseek/deepseek-chat` / `openai/gpt-4o-mini`） */
    model: z.string().optional(),
    /** 模型 API Key */
    apiKey: z.string().optional(),
    /** OpenAI 兼容端点地址（自建网关 / 代理）；留空走 provider 默认端点 */
    baseURL: z.string().optional(),
    // ── 技能目录（机制见 docs/design/ai-agent.md §1.4）──
    /**
     * 额外的技能目录（随部署打包的 `core/skills/catalog/` 之外）。
     *
     * 每个子目录一个技能（`<名字>/SKILL.md`）；默认 `~/.agents/skills`，可用 `AGENT_SKILLS_DIRS`
     * （逗号分隔多个）换成自己的目录。目录不存在就跳过；里面的坏技能只跳过、不拦启动。
     */
    skillsDirs: z.array(z.string()).default(['~/.agents/skills']),
    /**
     * 技能库的落盘目录（后台在线编辑 / 从 skills.sh、GitHub 链接导入 / agent 写入的技能都落到这里）。
     *
     * **这个目录由我们独占**：启动时会清掉库里不存在的技能目录，所以不要指向
     * `~/.agents/skills` 这种"还有别的东西"的目录；想加外部技能库请配 `skillsDirs`。
     */
    skillsLibraryDir: z.string().default('~/.billy/skills'),
    // ── 上下文策略（详见 docs/design/ai-agent.md §3.9）──
    /** 触发线：估算用量超过「模型窗口 × 本比例」就开始裁剪/压缩 */
    contextTriggerRatio: z.coerce.number().positive().max(1).default(0.7),
    /** 裁剪目标：裁到「窗口 × 本比例」为止 */
    contextTrimTargetRatio: z.coerce.number().positive().max(1).default(0.5),
    /** 压缩目标：摘要后到「窗口 × 本比例」为止 */
    contextCompactTargetRatio: z.coerce.number().positive().max(1).default(0.4),
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
    /** 心跳超时（ms）：超过就认为这一轮已经没人管了（崩溃或卡死） */
    heartbeatTimeoutMs: z.coerce.number().int().positive().default(60_000),
    /** 单轮总时长上限（ms）：超过即判超时（防"进程活着但模型 hang 住"永远挂着） */
    runTimeoutMs: z.coerce.number().int().positive().default(10 * 60_000),
    /**
     * 首 token 超时（ms）：从发起模型调用到**第一段输出**之间没有任何动静就判失败。
     *
     * 与 `runTimeoutMs`（总时长）是两件事：总时长防"跑不完"，这条防"卡住不吐字"。
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
    /** 单个子 agent 的墙钟上限（ms；0 = 沿用 runTimeoutMs） */
    subAgentTimeoutMs: z.coerce.number().int().nonnegative().default(0),
    // ── 命令执行（工具组 `BashTool`，设计文档 §3.15）──
    /**
     * 是否允许 agent 在本机执行命令行命令（**默认关**）。
     *
     * 这是**让模型在本机跑命令**的能力：命令以服务进程的身份与权限执行，
     * **能读写该身份能读写的一切，不是沙箱**（工具自己也在注释里写明了）。
     * 默认关；自用 / 内网确需时显式设 `AGENT_COMMAND_ENABLED=true`，
     * 对外部署保持关闭，真要本机执行请放进容器 / 低权限用户 / 只读工作区。
     */
    commandEnabled: z.boolean().default(false),
    /** 单条命令的时长默认值与硬上限（ms） */
    commandTimeoutMs: z.coerce.number().int().positive().default(15_000),
    /** 单条流的输出上限（字节）；超出即截断并终止命令 */
    commandMaxOutputBytes: z.coerce.number().int().positive().default(64 * 1024),
    /** 命令的工作根目录（缺省 = 服务进程工作目录）；agent 只能在这个目录之内指定 cwd */
    commandWorkDir: z.string().optional(),
    // ── 联网（工具组 `WebTools`：`web-fetch` / `web-request` / `web-search`）──
    /**
     * 是否允许 agent 出网（**默认开**）。
     *
     * 关掉后联网工具仍在，但每次调用返回"已被关闭"的结论。
     * 完全不给模型联网能力的部署置 `false`。
     */
    webEnabled: z.boolean().default(true),
    /** 单次请求的总时长默认值与硬上限（ms）：整条重定向链共用这一个预算 */
    webTimeoutMs: z.coerce.number().int().positive().default(20_000),
    /** 单次请求最多读多少字节（超出即截断，工具出参里给 `truncated`） */
    webMaxBytes: z.coerce.number().int().positive().default(2 * 1024 * 1024),
    /**
     * 是否允许访问内网 / 回环地址（**默认关**）。
     *
     * 关着的时候 `127.0.0.1` / `10.x` / `169.254.169.254` 一律拒绝 ——
     * 网页内容可以诱导模型去请求这些地址（SSRF）。要抓本机服务时，这里与工具配置**两处都要打开**。
     */
    webAllowPrivateNetwork: z.boolean().default(false),
    // ── 工具引擎（设计 ai-agent-tool-engine.md §5.5 / §5.6）──
    /**
     * 单次给模型的工具出参上限（字节）**硬上限**。
     *
     * 工具的分页阈值可以在后台按工具改，但改不出这个上限 —— DB 被改坏也突破不了部署边界。
     */
    toolPageBytesMax: z.coerce.number().int().positive().default(8 * 1024),
    /** 每轮取页次数**硬上限**（防模型反复取页烧 token） */
    toolMaxPagesPerTurnMax: z.coerce.number().int().positive().default(5),
  }),
  /**
   * AI 模型模块配置（配置类数据：供应商 / 模型，见设计文档 §4.8）。
   *
   * 与本模块的数据表配套：只要"要不要用环境变量做首次种子"。
   * 密钥**明文入库**（2026-10-01 决定），所以这里不再有加密口令。
   */
  aiModel: z.object({
    /** 密钥加密口令（AES-256-GCM）；缺省回落 `jwt.secret`，两者都缺 → 服务层抛 3405 */
    /** 首次启动时是否允许用 `MASTRA_*` 环境变量种子初始化供应商与模型（库里有供应商就什么都不做） */
    seedFromEnv: z.boolean().default(true),
  }),
})

export type ServerAppConfig = z.infer<typeof serverAppConfigSchema>

/** 空串视为未配置（env 常见写法 `KEY=`） */
const optional = (value: string | undefined): string | undefined =>
  value ? value : undefined

const optionalNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined
}

const parseBoolean = (value: string | undefined): boolean | undefined =>
  value === undefined ? undefined : value === 'true'

/** 解析 `key=number,key=number`（用于按模型覆盖上下文窗口） */
const parseKeyValueNumbers = (
  value: string | undefined,
): Record<string, number> | undefined => {
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

const parseList = (value: string | undefined): string[] | undefined =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)

/**
 * 环境变量 → 嵌套配置。未设置的键留 `undefined`，由 schema 默认值兜底。
 */
export const mapServerEnv = (
  env: NodeJS.ProcessEnv,
): Record<string, unknown> => ({
  server: {
    port: optional(env.PORT),
    authEnabled:
      env.AUTH_ENABLED === undefined ? undefined : env.AUTH_ENABLED !== 'false',
    resetPasswordTokenTtlMinutes: optional(env.RESET_PASSWORD_TOKEN_TTL_MINUTES),
    rateLimitWhitelist: parseList(env.RATE_LIMIT_WHITELIST),
    rateLimitTrustProxy: parseBoolean(env.RATE_LIMIT_TRUST_PROXY),
    keepAliveTimeoutMs: optional(env.KEEP_ALIVE_TIMEOUT_MS),
    headersTimeoutMs: optional(env.HEADERS_TIMEOUT_MS),
    appVersion: optional(env.APP_VERSION),
    shutdownTimeoutMs: optional(env.SHUTDOWN_TIMEOUT_MS),
  },
  db: {
    url: optional(env.DB_URL),
    sync: parseBoolean(env.DB_SYNC),
  },
  redis: {
    url: optional(env.REDIS_URL),
    keyPrefix: optional(env.REDIS_KEY_PREFIX),
  },
  jwt: {
    secret: optional(env.JWT_SECRET),
    expiresIn: optional(env.JWT_EXPIRES_IN),
  },
  password: {
    passwordHashRounds: optional(env.PASSWORD_HASH_ROUNDS),
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
    pretty:
      env.NODE_ENV === undefined ? undefined : env.NODE_ENV !== 'production',
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
            env.ALERT_SMTP_SECURE === undefined
              ? undefined
              : env.ALERT_SMTP_SECURE !== 'false',
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
  agent: {
    model: optional(env.MASTRA_MODEL),
    apiKey: optional(env.MASTRA_API_KEY),
    baseURL: optional(env.MASTRA_BASE_URL),
    skillsDirs: parseList(env.AGENT_SKILLS_DIRS),
    ...(env.AGENT_SKILLS_LIBRARY_DIR ? { skillsLibraryDir: env.AGENT_SKILLS_LIBRARY_DIR } : {}),
    contextTriggerRatio: optional(env.AGENT_CONTEXT_TRIGGER_RATIO),
    contextTrimTargetRatio: optional(env.AGENT_CONTEXT_TRIM_TARGET_RATIO),
    contextCompactTargetRatio: optional(env.AGENT_CONTEXT_COMPACT_TARGET_RATIO),
    contextKeepRecentTurns: optional(env.AGENT_CONTEXT_KEEP_RECENT_TURNS),
    contextToolResultMaxRatio: optional(env.AGENT_CONTEXT_TOOL_RESULT_MAX_RATIO),
    contextToolResultTotalRatio: optional(env.AGENT_CONTEXT_TOOL_RESULT_TOTAL_RATIO),
    contextFallbackWindow: optional(env.AGENT_CONTEXT_FALLBACK_WINDOW),
    contextModelWindows: parseKeyValueNumbers(env.AGENT_CONTEXT_MODEL_WINDOWS),
    durableEnabled:
      env.AGENT_DURABLE_ENABLED === undefined ? undefined : env.AGENT_DURABLE_ENABLED !== 'false',
    heartbeatTimeoutMs: optional(env.AGENT_HEARTBEAT_TIMEOUT_MS),
    runTimeoutMs: optional(env.AGENT_RUN_TIMEOUT_MS),
    firstTokenTimeoutMs: optional(env.AGENT_FIRST_TOKEN_TIMEOUT_MS),
    watchdogIntervalMs: optional(env.AGENT_WATCHDOG_INTERVAL_MS),
    multiInstance: parseBoolean(env.AGENT_MULTI_INSTANCE),
    subAgentMaxPerRun: optional(env.AGENT_SUB_AGENT_MAX_PER_RUN),
    subAgentMaxDepth: optional(env.AGENT_SUB_AGENT_MAX_DEPTH),
    subAgentMaxSteps: optional(env.AGENT_SUB_AGENT_MAX_STEPS),
    subAgentTimeoutMs: optional(env.AGENT_SUB_AGENT_TIMEOUT_MS),
    commandEnabled: parseBoolean(env.AGENT_COMMAND_ENABLED),
    commandTimeoutMs: optional(env.AGENT_COMMAND_TIMEOUT_MS),
    commandMaxOutputBytes: optional(env.AGENT_COMMAND_MAX_OUTPUT_BYTES),
    commandWorkDir: optional(env.AGENT_COMMAND_WORK_DIR),
    webEnabled: parseBoolean(env.AGENT_WEB_ENABLED),
    webTimeoutMs: optional(env.AGENT_WEB_TIMEOUT_MS),
    webMaxBytes: optional(env.AGENT_WEB_MAX_BYTES),
    webAllowPrivateNetwork: parseBoolean(env.AGENT_WEB_ALLOW_PRIVATE_NETWORK),
    toolPageBytesMax: optional(env.AGENT_TOOL_PAGE_BYTES_MAX),
    toolMaxPagesPerTurnMax: optional(env.AGENT_TOOL_MAX_PAGES_PER_TURN),
  },
  aiModel: {
    // 未设置时留 undefined，由 schema 默认值（true）兜底
    seedFromEnv: parseBoolean(env.AGENT_SEED_FROM_ENV),
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
