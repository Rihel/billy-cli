import type {
  AuthStrategy,
  CredentialProvider,
  CredentialsManager,
} from '../core/interfaces.js'

/** SSE 传输消息（帧解析结果，data 为原始字符串）。 */
export interface StreamMessage {
  /** 事件 id（续传用；可能为空字符串） */
  id: string
  /** 事件名（空事件名按 'message' 处理） */
  event: string
  /** 原始数据（业务负载为 JSON 字符串） */
  data: string
  /** 服务端建议的重连间隔（毫秒） */
  retry?: number
}

/**
 * 客户端连接状态机状态（TS 字符串枚举：集中管理状态名，值即字符串字面量）。
 * 状态值必须经 StreamClientState 引用，类型强约束、杜绝魔法字符串。
 */
export enum StreamClientState {
  Idle = 'idle',
  Connecting = 'connecting',
  Open = 'open',
  Reconnecting = 'reconnecting',
  Closed = 'closed',
}

/**
 * 事件处理器。
 * @param data JSON 反序列化后的负载；无法解析时原样给原始字符串
 * @param message 完整传输消息（含 id / event / data 原始值）
 */
export type StreamEventHandler = (data: unknown, message: StreamMessage) => void

/**
 * HttpStreamClient 构造选项。
 *
 * `Credentials` 与 `HttpClient` 一致地泛型化，使「SSE 复用普通请求的凭证管理器」无需断言；
 * 不传类型参数时按 `Record<string, any>` 处理（与改造前行为一致）。
 */
export interface StreamClientOptions<Credentials = Record<string, any>> {
  /** 订阅地址，如 '/sse/subscribe' */
  url: string
  /** HTTP 方法，默认 'POST'（贴合工程「统一 POST」约定） */
  method?: string
  /** 订阅频道；POST 时序列化为 body { channels } */
  channels?: string[]
  /**
   * 自定义请求体（覆盖 channels 默认序列化）。
   * 传 `null` 表示**显式无请求体**（此时不会回落成 `{ channels }`，也不补 Content-Type）。
   */
  body?: unknown
  /**
   * 基础请求头（认证 header 由 authStrategy 注入）。
   * 带请求体时客户端会自动补 `Content-Type: application/json`（已显式设置则不覆盖）。
   */
  headers?: Record<string, string>
  /** 凭证管理器（CredentialsManager 实现，如 MemoryCredentialsManager / LocalStorageCredentialsManager） */
  credentialsManager: CredentialsManager<Credentials>
  /** 认证策略（AuthStrategy 实现，如 BearerTokenStrategy） */
  authStrategy: AuthStrategy<Credentials>
  /** 凭证提供器（可选，凭证可刷新场景） */
  credentialProvider?: CredentialProvider<Credentials>
  /** 自定义 fetch（测试注入 / 定制），默认全局 fetch（浏览器 / Node 18+ 原生） */
  fetch?: typeof fetch
  /** 浏览器：页面隐藏时是否继续连接，默认 false（隐藏时断开，恢复后自动重连） */
  openWhenHidden?: boolean
  /** 初始重试间隔毫秒，默认 1000 */
  retryInterval?: number
  /** 最大重试间隔毫秒，默认 30000 */
  maxRetryInterval?: number
}
