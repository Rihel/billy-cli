import pino from 'pino'

export type LogFunction = (message?: string, data?: unknown) => void

export interface AppLogger {
  setContext(context: string): void
  log: LogFunction
  info: LogFunction
  warn: LogFunction
  debug: LogFunction
  error: LogFunction
}

/**
 * 可选的 pino 透传项（默认不启用，调用方按部署需要传）。
 *
 * 为什么需要：`createLogger` 是薄封装，但脱敏（redact）与多目标 transport（落盘 / pino-loki）
 * 只能在 pino 构造时指定，不透传就没法用——而这两项分别是安全与生产可观测性的刚需。
 */
export interface CreateLoggerOptions {
  /** pino redact 的路径列表（命中即替换为 `[REDACTED]`），如 `['req.headers.authorization']` */
  redact?: string[]
  /** pino transport；给了就优先于 `pretty`（多目标 / pino-loki 等） */
  transport?: pino.TransportSingleOptions | pino.TransportMultiOptions
}

/**
 * `createLogger` 的返回值：日志统一入口 + `child()`。
 *
 * `child(context)` 在**同一个 pino 实例**上派生子封装——pino 的 `transport` 会为每个实例拉起
 * 一个 worker 线程，所以多 context 场景（如每个宿主类一个 logger）必须走 `child()`，
 * 不能反复调 `createLogger()`。
 */
export interface CreateLoggerResult extends AppLogger {
  child(context: string): CreateLoggerResult
}

/** 在一个已有 pino 实例上包一层封装（`child()` 复用它，避免重复创建 transport） */
const wrap = (instance: pino.Logger): CreateLoggerResult => {
  let logger = instance
  /** 兼容既有调用：第二参传字符串时视为「消息前缀」 */
  const normalize = (message?: string, data?: unknown) => {
    if (typeof data === 'string') {
      return { message: `${data} ${message}`, data: {} as unknown }
    }
    return { message, data }
  }
  return {
    setContext(context: string) {
      logger = logger.child({ context })
    },
    child(context: string) {
      return wrap(logger.child({ context }))
    },
    log: (message?: string, data?: unknown) => {
      const n = normalize(message, data)
      logger.info(n.data, n.message)
    },
    info: (message?: string, data?: unknown) => {
      const n = normalize(message, data)
      logger.info(n.data, n.message)
    },
    warn: (message?: string, data?: unknown) => {
      const n = normalize(message, data)
      logger.warn(n.data, n.message)
    },
    debug: (message?: string, data?: unknown) => {
      const n = normalize(message, data)
      logger.debug(n.data, n.message)
    },
    error: (message?: string, data?: unknown) => {
      const n = normalize(message, data)
      logger.error(n.data, n.message)
    },
  }
}

export function createLogger(
  name: string,
  pretty = false,
  level: pino.LevelWithSilentOrString = 'info',
  options: CreateLoggerOptions = {},
): CreateLoggerResult {
  const instance = pino({
    name,
    level,
    ...(options.redact && options.redact.length > 0
      ? { redact: { paths: options.redact, censor: '[REDACTED]' } }
      : {}),
    ...(options.transport
      ? { transport: options.transport }
      : pretty
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
                ignore: 'pid,hostname',
                // 条件前缀：有 context 才渲染，避免无上下文的日志出现空的 "[]"
                messageFormat: '{if context}[{context}] {end}{msg}',
              },
            },
          }
        : {}),
  })
  return wrap(instance)
}
