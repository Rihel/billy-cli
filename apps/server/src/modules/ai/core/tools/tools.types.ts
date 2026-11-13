import type { AiToolEventModel } from '@repo/shared'
import type { z } from 'zod'

/**
 * **工具 DSL 与运行时数据结构**（设计 `docs/design/ai-agent-tool-engine.md` §5.2 / §5.4）。
 *
 * 这一层是**主体**：不许 import `@mastra/*`（由 `pnpm check:mastra` 守）。
 * Mastra 只经 `ai/mastra/tool.adapter.ts` 接入，词汇映射只在那里做一次。
 *
 * 术语：
 * - **声明（ToolSpec）**：一个工具不可变的部分 —— 名称 / 说明 / 参数定义 / 配置定义（含默认值）/
 *   执行体。写在代码里，启动期注册。
 * - **配置（ToolSettings）**：可变的那些（开关 / 作用域 / 限额 / 配置值 / 秘钥），入库、免重启生效。
 * - **网关（ToolGateway）**：所有工具调用的必经之路（插件链、统一结论）。
 * - **结论（ToolOutcome）**：成功给数据，失败给"能读懂、可纠正"的理由 —— **失败不是崩溃**。
 */

/** 工具 key 的稳定取值（`tool-keys.ts` 是唯一事实源） */
export type ToolKeyValue = string

/** 作用域取值（`ToolScope` 字典是唯一事实源，这里用字面量收窄，避免主体依赖字典实现） */
export type ToolScopeValue = 'all' | 'admin' | 'user' | 'agent'

/** 工具类别（`category:<值>` 选择器的可用取值；新增类别时一并加在这里） */
export const TOOL_CATEGORY_VALUES = ['core', 'business', 'runtime', 'connector'] as const

/** 工具类别 */
export type ToolCategoryValue = (typeof TOOL_CATEGORY_VALUES)[number]

/**
 * 自定义事件的发出方式（`@repo/shared` 的 `ToolEventMode` 字典是唯一事实源，
 * 这里用字面量收窄，避免主体依赖字典实现）。
 *
 * 取值决定 AI SDK 的 id 归并策略，进而在前端表现为「最新快照」或「全部流水」（设计 §5.17）。
 */
export type ToolEventModeValue = 'state' | 'stream'

/**
 * 事件**声明**（`@ToolDecl({ events })` 里写的那一份，归一化前）。
 *
 * 为什么要单独声明：事件是工具往父流里吐的**额外过程信息**，前端按名字找渲染器；
 * 名字 / 标题 / 说明 / 形状只有代码知道，所以声明在代码、镜像入库供管理页只读展示。
 */
export interface ToolEventDeclMeta {
  /** 事件名：工具内唯一（≤64），前端渲染器按它匹配（禁止裸字符串拼接，用声明里的常量） */
  name: string
  /** 人读标题（管理页展示 + 前端兜底渲染的标题） */
  title: string
  /** 什么时候发、payload 各字段什么意思 */
  description: string
  /** 省略 = `'state'`（状态快照：带稳定 id，后发覆盖先发） */
  mode?: ToolEventModeValue
  /** payload 定义（可选；写了就在发射时 `safeParse`，不符合定义的事件被丢弃并记 warn） */
  payload?: z.ZodType
}

/**
 * 事件声明**归一化后**的形态（注册机拍平进 `ToolSpec.events`）。
 *
 * `payloadSchema` 是 `payload` 数据结构的 JSON Schema 化（**没声明 payload 定义时为 null**），
 * 只给管理页只读展示 —— 运行时校验用的是 `payload` 本体，不必再过一次 JSON Schema。
 */
export interface ToolEventDecl {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly mode: ToolEventModeValue
  readonly payload?: z.ZodType
  readonly payloadSchema: Record<string, unknown> | null
}

/** 事件声明的宽类型（内部管道不关心 payload 的具体泛型） */
export type AnyToolEventDecl = ToolEventDecl

/** 日志统一入口（结构上兼容 `@repo/kits` 的 AppLogger，测试里给静默实现即可） */
export interface ToolLogger {
  debug(message?: string, data?: unknown): void
  log(message?: string, data?: unknown): void
  info(message?: string, data?: unknown): void
  error(message?: string, data?: unknown): void
  warn(message?: string, data?: unknown): void
}

/** 时钟（分页与耗时都要确定性：测试换实现即可） */
export interface ToolClock {
  now(): number
}

/** 部署侧硬上限（env）：DB 被改坏也突破不了 */
export interface ToolEnvCaps {
  /** 单次给模型的出参上限（字节）硬上限 */
  pageBytesMax: number
  /** 每轮取页次数硬上限 */
  maxPagesPerTurnMax: number
  /** 命令执行的部署边界（`AGENT_COMMAND_*`）：既有部署的 env 语义由此保留 */
  command?: {
    enabled: boolean
    timeoutMsMax: number
    maxOutputBytesMax: number
    workDir?: string
  }
  /**
   * 联网的部署边界（`AGENT_WEB_*`）。
   *
   * `allowPrivateNetwork` 在这里是**硬闸**：env 没打开时，后台把工具配置里的同名字段打开也不生效 ——
   * 允许模型访问内网是部署方的决定，不该由页面上的一个开关决定。
   */
  web?: {
    enabled: boolean
    timeoutMsMax: number
    maxBytesMax: number
    allowPrivateNetwork: boolean
  }
  /** 文件管理的部署边界（env）：库里的值再大也突破不了 */
  file?: {
    maxBytesMax?: number
    maxFilesMax?: number
    maxTotalBytesMax?: number
    readMaxBytesMax?: number
    pageLinesMax?: number
    pageCharsMax?: number
    writeBytesMax?: number
    searchFilesMax?: number
    searchBytesMax?: number
    searchResultsMax?: number
    workspaceFilesMax?: number
    workspaceDepthMax?: number
  }
}

/** 工具往"父流"里写实时明细的最小面（子 agent 靠它把过程写进父那一条流） */
export interface ToolWriter {
  write(chunk: unknown): Promise<unknown> | unknown
}

/** 工具限额（库里可覆盖；null / 缺省 = 不限制） */
export interface ToolLimits {
  maxPerTurn?: number | null
  rateLimit?: { windowSeconds: number; max: number } | null
  pageBytes?: number | null
  maxPagesPerTurn?: number | null
}

/** 秘钥字段的元信息（页面渲染 + 缺配置时的结论文案） */
export interface ToolSecretField {
  name: string
  label: string
  /** 必填的秘钥缺了就调不了（`precheck-failed` 结论） */
  required?: boolean
}

/** 生效配置（库里的值 + 代码默认值 + env 上限夹紧之后的结果） */
export interface ToolSettings<C = Record<string, unknown>> {
  key: string
  title: string
  description: string
  enabled: boolean
  scope: ToolScopeValue
  allowedAgents: readonly string[]
  /** 合并后的**完整**配置（代码默认值已补齐） */
  config: C
  limits: ToolLimits
  /** 来源：`seed`（只有代码默认值）/ `manual`（人工改过配置） */
  source: 'seed' | 'manual'
  /** 参数定义的 JSON Schema（库里的声明镜像；缺省时由声明现算） */
  paramSchema?: Record<string, unknown> | null
  /**
   * 自定义事件声明的**镜像**（库里的值；缺省时用代码声明，见设计 §5.17）。
   *
   * 只给管理台读（与 `paramSchema` 同一口径），**不参与运行时** ——
   * 发射器认的是 `spec.events`（代码声明是唯一事实源，库被改坏也发不出未声明的事件）。
   */
  events?: readonly AiToolEventModel[]
  /** 配置版本（库里那行的 updatedAt ISO；没有配置行时 `code-default`）——落审计，重放可解释 */
  version: string
  /** 取秘钥明文（未配置返回 null）。只在这一次调用内使用，禁止落库 / 进日志 */
  secret(name: string): string | null
  /** 秘钥提示串（`sk-…abcd`），可以进日志与页面 */
  secretHint(name: string): string | null
}

/**
 * 判作用域需要的**最小身份**（装配期过滤工具面与调用期兜底共用）。
 *
 * 不从 `ToolCaller` 上截取：装配期拿不到 conversationId / runId，只有信封里的这两项。
 */
export interface ToolCallerIdentity {
  readonly isAdmin: boolean
  readonly rootAgentKey: string
}

/** 谁在调这次工具（来自编排层注入的运行时信封） */
export interface ToolCaller {
  conversationId: string
  /** 当前这一轮的根 run id */
  runId: string
  /** 发起人（用户 / 管理员 id；无身份时为 null） */
  userId: string | null
  /** 触发身份是不是管理员 */
  isAdmin: boolean
  /** 调用方 agent key（子 agent 为 `sub:<名字>`） */
  agentKey: string
  /** **根** agent key（子 agent 沿用父的判定，作用域按它算） */
  rootAgentKey: string
  /** 深度（根 agent = 0） */
  depth: number
}

/** 分页页头（给模型的那一份里带它） */
export interface ToolPageMeta {
  page: number
  pageSize: number
  totalBytes: number
  totalPages: number
  hasMore: boolean
  /** 取页句柄（`read-tool-result` 用它回取） */
  handle: string
}

/** 分页后的成功出参：**`data` 仍是全量**，只有"给模型的那一份"是第一页（适配器用 toModelOutput 映射） */
export interface PagedToolValue {
  readonly __toolPaged: true
  readonly page: ToolPageMeta
  readonly data: unknown
}

export const isPagedToolValue = (value: unknown): value is PagedToolValue =>
  typeof value === 'object' &&
  value !== null &&
  (value as { __toolPaged?: unknown }).__toolPaged === true

/** 统一的拒绝原因 */
export type ToolDenyReasonValue =
  | 'unknown-tool'
  | 'upstream'
  | 'invalid-input'
  | 'precheck-failed'
  | 'disabled'
  | 'forbidden'
  | 'rate-limited'
  | 'timeout'
  | 'aborted'
  | 'internal'

/** 统一结论：成功给数据，失败给**可纠正**的理由（模型据此改口或换个做法） */
export type ToolOutcome<T = unknown> =
  | { ok: true; data: T; notices?: string[] }
  | {
      ok: false
      reason: ToolDenyReasonValue
      message: string
      /** 给模型的下一步建议（缺省时由插件按 reason 补） */
      hint?: string
      /** 重试同样的调用有没有意义（限流 / 超时是真，权限不是） */
      retryable?: boolean
    }

/**
 * 执行体里的**拒绝**（如取页的越权判定）：抛出它，网关会翻成对应 reason 的统一结论。
 *
 * 为什么要有它：`exec` 的返回类型是"成功的数据"，没法表达"我拒绝"；而拒绝又不该是
 * `internal`（那是我们写错了）。用这个异常把两者分开，且**它永远不会炸整轮**
 * （Mastra 把工具错误落成工具错误结果，用例 ③ 实测）。
 */
export class ToolDeniedError extends Error {
  constructor(
    readonly reason: ToolDenyReasonValue,
    message: string,
    readonly hint?: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ToolDeniedError'
    // 业务拒绝只给结论（原因 + 提示），不要把内部堆栈带到模型/前端可见的错误卡片里
    this.stack = undefined
  }
}

/** 一次工具调用的上下文（插件只读它；执行体只读 `input` / `settings` / `envelope`） */
export interface ToolCallContext<C = Record<string, unknown>> {
  /** 这一次调用的**声明**（参数 / 配置定义、秘钥字段、precheck 都在它上面） */
  readonly spec: ToolSpec<C>
  readonly toolKey: string
  readonly toolCallId: string | null
  /** 调用方信息（信封缺失时为 null） */
  readonly caller: ToolCaller | null
  readonly settings: ToolSettings<C>
  /** 原始运行时信封（core 工具要用它，如子 agent 的模型与工具面）。类型见 `core/envelope` */
  readonly envelope: unknown
  readonly signal?: AbortSignal
  readonly log: ToolLogger
  readonly clock: ToolClock
  /**
   * 这次调用的**理由**（模型必填，设计 §5.18）：为什么这次要用这个工具。
   *
   * 由网关从入参里摘出来统一赋值（`ValidatePlugin` 把 `reason` 从业务入参里分离），
   * 工具**可以**读它写进自己的业务日志，但**不要求**任何工具去读。
   */
  reason: string | null
  /** 归一化前的入参（审计用） */
  readonly rawInput: unknown
  /** 归一化后的入参（`spec.exec` 只应读它） */
  input: unknown
  /** 插件写：执行结论 */
  outcome?: ToolOutcome<unknown>
  /** 插件写：分页页头（有了它就说明出参被包成了 `PagedToolValue`） */
  page?: ToolPageMeta
  /** 插件写：本次调用的配置版本（落审计） */
  configVersion?: string
  /** 插件写：开始时间（耗时统计） */
  startedAt?: number
  /** 插件写：本轮的取页次数（`read-tool-result` 用） */
  pagesRead?: number
  /** 实时明细出口（Mastra 工具上下文给的；非流式调用时为 undefined） */
  readonly writer?: ToolWriter
  /**
   * 往父流发一条**自定义事件**（设计 §5.17）：`emit(name, payload?)`。
   *
   * 语义（由网关实现，执行体只当它是一个开关）：
   * - **同步、永不抛**：事件失败（未声明 / payload 不符合定义 / 写流报错）只记 warn，
   *   绝不影响本次工具调用的结论 —— 事件是过程，出参才是结论；
   * - **没有 writer 就静默 no-op**（后台调用 / 非流式链路没有父流可写）；
   * - 归并策略按声明里的 `mode` 在服务端定，前端不判断去重。
   */
  readonly emit: (name: string, payload?: unknown) => void
}

/** 工具声明：不可变的部分（代码里写死；值入库的是 `ToolSettings`） */
export interface ToolSpec<C = Record<string, unknown>, I = unknown, O = unknown> {
  /** 名称：稳定对外标识（取自 `tool-keys.ts`，禁止裸字符串） */
  readonly key: ToolKeyValue
  /** 人读标题（提示词列举用；库里可覆盖） */
  readonly title: string
  /** 唯一一份说明：是什么 / 什么时候用 / 什么时候不用 / 纪律（模型选工具看到的也是它） */
  readonly description: string
  readonly category: ToolCategoryValue
  /** 参数定义（给模型的 JSON Schema 由它生成） */
  readonly params: z.ZodType<I>
  /**
   * **给模型看的那一份参数定义** = `params` + 引擎注入的必填 `reason`（设计 §5.18）。
   *
   * 由 `buildToolSpecs` 统一包好（工具作者不用管），两个消费方：
   * - 适配器把它当 Mastra 的 `inputSchema`（→ 模型看到的 JSON Schema 里 `reason` 必填）；
   * - 网关的 `ValidatePlugin` 用它校验入参，再把 `reason` 摘回 `ctx.reason`。
   *
   * 因此**执行体拿到的 `input` 仍是 `params` 的形状**（缺失时回落到 `params`，测试替身无需构造它）。
   */
  readonly modelParams?: z.ZodType<I & { reason: string }>
  /** 出参定义（可选：标准测试集可校验实现是否守约） */
  readonly result?: z.ZodType<O>
  /**
   * 配置定义：**每个字段都必须用 zod `.default()` 给出默认值**。
   *
   * 代码默认值由 `spec.config.parse({})` 得到（不单列 `defaults` 字段，单列就会与 schema 漂移）；
   * `parse({})` 失败说明默认值没给全，启动即失败。
   */
  readonly config: z.ZodType<C>
  /** 秘钥定义：字段一律可选、**没有默认值**（默认状态是"未配置"） */
  readonly secrets?: z.ZodType<Record<string, string | undefined>>
  /** 秘钥字段元信息（页面渲染与"缺哪个"的结论文案） */
  readonly secretFields?: readonly ToolSecretField[]
  /**
   * 自定义事件声明（归一化后；没声明就是空数组）。
   *
   * 网关按它造 `ctx.emit`：**未声明的名字发不出去**，payload 不符合定义的也被丢弃 ——
   * 于是"工具会吐什么"在代码里是封闭的、可对账的（设计 §5.17）。
   */
  readonly events: readonly ToolEventDecl[]
  /**
   * 连接器来源（只有连接器产出的工具才有）。
   *
   * 网关的 `connector-guard` 插件靠它做"实例总闸"：实例停用 / 缺密钥时拒绝调用。
   * 不放进设置对象（`ToolSettings`）——那是可被库覆盖的值，来源是不可变的声明。
   *
   * `toolName` 是**接入方的工具原名**（不是归一化后的 key 尾巴）：`connector:<实例>/<工具>`
   * 选择器按它精确匹配，不做 key 反解（实例 key 与工具名都含 `-`，反解必然歧义）。
   */
  readonly connector?: {
    readonly id: string
    readonly key: string
    readonly toolName?: string
  }
  /** 默认作用域（库里可覆盖） */
  readonly scope: ToolScopeValue
  /** 委派类工具（创建 / 指挥子 agent）：子 agent 工具面要把它们排除 */
  readonly delegation?: boolean
  /** 子 agent 能不能用（默认能；`delegation` 隐含不能） */
  readonly child?: 'allow' | 'deny'
  /** 声明"我会返回大结果"才分页（不声明就不套这一层） */
  readonly paginate?: { readonly pageBytes: number }
  /**
   * 前置条件（**只读、快、无副作用**）：返回一句拒绝理由，或 null 表示通过。
   *
   * 需要查库也可以（依赖由 bean 注入），但必须是只读的：它失败时不该留下任何副作用。
   */
  readonly precheck?: (input: I, ctx: ToolCallContext<C>) => Promise<string | null> | string | null
  /** 配置归一化（夹紧到部署上限等）；纯函数，标准测试集覆盖 */
  readonly normalize?: (config: C, caps: ToolEnvCaps) => C
  /** 执行体：只写业务动作（开关 / 边界 / 分页 / 审计全在插件里） */
  exec(input: I, ctx: ToolCallContext<C>): Promise<O>
}

/**
 * 内部管道用的"任意声明"别名（种子同步 / 仓储 / 配置读取都不关心具体泛型）。
 *
 * 为什么用 `any`：`ToolSpec<C>` 在 `C` 上是不变的（`config: z.ZodType<C>` 双向使用），
 * 写成 `ToolSpec<unknown>` 会让所有具体声明都赋不进去 —— 与 TypeORM 的 `DeepPartial` 同一类问题。
 */
export type AnyToolSpec = ToolSpec<any, any, any>

/**
 * 全部**工具组实例**的注入 token（Nest 多 provider 惯用法）。
 *
 * 在 `ai.module.ts` 里用 `{ provide: AGENT_TOOL_GROUPS, inject: [A, B, C], useFactory: (...groups) => groups }`
 * 汇总 —— 新增工具组要在这里登记一行。注册机对每个实例跑 `buildToolSpecs()` 拿声明数组
 * （**一个组 1..n 个工具**；组类用 `@ToolGroup` + 方法上的 `@ToolDecl` 声明，见 `tool.decorator.ts`）。
 */
export const AGENT_TOOL_GROUPS = Symbol.for('AgentToolGroups')

/**
 * 「这个 agent 可用此刻注册机里的全部工具」的标记（照技能侧 `ALL_SKILLS` 的写法）。
 *
 * 为什么需要它：连接器产出的工具是运行期出现的，agent 定义里写不出具体 key。
 * 装配时展开成"当时注册机里的全部 key"；取值用 `*`（真实工具 key 的形状不允许 `*`）。
 */
export const ALL_TOOLS = '*'

/** 网关包装后的工具（注册机对外只发这种；适配器把它转成 Mastra 工具） */
export interface Tool {
  readonly key: string
  readonly spec: ToolSpec
  /** 一次调用：插件链 → 执行体 → 出参处理，**永不抛业务异常**（失败是 `ToolOutcome`） */
  run(rawInput: unknown, call: ToolCallInput): Promise<ToolOutcome<unknown>>
}

/** `Tool.run` 的调用输入（由适配器从 Mastra 的工具执行上下文转换而来） */
export interface ToolCallInput {
  callId: string | null
  envelope: unknown
  signal?: AbortSignal
  log: ToolLogger
  /** 实时明细出口（来自 Mastra 的工具上下文；由适配器转换过来） */
  writer?: ToolWriter
}

/**
 * 网关插件：一个处理单元（设计 §5.4）。
 *
 * 约定：
 * - **pre 返回结论 = 短路**（不执行工具）；返回 `void` 表示放行；
 * - **安全类插件只累积拒绝**：`enabled` / `scope` / `rate-limit` 不覆盖别人给出的拒绝；
 * - post 只加工（脱敏 / 分页 / 审计），不改已确定的业务事实；
 * - 插件不互相调用：顺序由装配处的数组决定。
 */
export interface ToolPlugin {
  /** 插件名（日志、排查用；也是 env 里关掉它的标识） */
  readonly name: string
  pre?(ctx: ToolCallContext): Promise<ToolOutcome<never> | void> | ToolOutcome<never> | void
  post?(ctx: ToolCallContext): Promise<void> | void
}

/** 工具箱：key → 工具（主体自己的类型，不再是 Mastra 的 `ToolsInput`） */
export type Toolbox = ReadonlyMap<string, Tool>
