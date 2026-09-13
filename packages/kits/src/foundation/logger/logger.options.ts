import type { Params } from 'nestjs-pino'
import type { LoggerConfig } from './logger.config.js'
import { resolvePretty } from './logger.config.js'

/** pino-http 的请求/响应定制点（由应用层注入，kits 不感知具体请求上下文实现） */
export interface LoggerHttpOptions {
  /** 每条请求日志附加上下文（如从请求上下文取 userId） */
  customProps?: (request: unknown, response: unknown) => Record<string, unknown>
  /** 自定义请求 id 来源；缺省取响应头 `X-Request-Id`，取不到则用 crypto.randomUUID() */
  genReqId?: (request: unknown, response: unknown) => string
}

/** 默认脱敏路径：避免把凭证写进日志（rihel-base 未做，这里补上） */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
]

/**
 * 由 LoggerConfig 构造 nestjs-pino 的 `Params`（含 pino-http 配置）。
 *
 * 与 rihel-base 的 `buildHttpOptions` 对齐：
 * - 生产 + 配了 loki：多目标 transport（pino/file 落盘 + pino-loki 推送，带 labels 与批量间隔）；
 * - 非生产：pino-pretty（彩色、时间格式、`[{context}] {msg}` 消息模板）；
 * - `renameContext: 'context'`，使 Nest 内部 Logger 的 context 字段统一为 `context`。
 */
export const buildLoggerParams = (
  config: LoggerConfig,
  http: LoggerHttpOptions = {},
): Params => {
  const pretty = resolvePretty(config)

  const pinoHttp: Record<string, unknown> = {
    name: config.prefix,
    level: config.level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    genReqId:
      http.genReqId ??
      ((_request: unknown, response: unknown) => {
        const header = (response as { getHeader?: (name: string) => unknown })
          ?.getHeader?.('X-Request-Id')
        return typeof header === 'string' && header ? header : crypto.randomUUID()
      }),
    customProps: http.customProps,
  }

  if (!pretty && config.loki) {
    pinoHttp.transport = {
      targets: [
        { target: 'pino/file', level: config.level },
        {
          target: 'pino-loki',
          level: config.level,
          options: {
            host: config.loki.host,
            labels: { app: config.prefix, ...config.loki.labels },
            batchingInterval: config.loki.batchInterval,
          },
        },
      ],
    }
  } else if (pretty) {
    pinoHttp.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
        // 条件前缀：有 context 才渲染，避免 pino-http 请求日志出现空的 "[]"
        messageFormat: '{if context}[{context}] {end}{msg}',
      },
    }
  }

  return {
    pinoHttp,
    renameContext: 'context',
  } as Params
}
