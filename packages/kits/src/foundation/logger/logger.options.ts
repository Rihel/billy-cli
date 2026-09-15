import type { CreateLoggerOptions } from '@repo/shared/logger'
import type { LoggerConfig } from './logger.config.js'
import { resolvePretty } from './logger.config.js'

/** 默认脱敏路径：避免把凭证写进日志 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
]

/**
 * 由 LoggerConfig 构造 `createLogger` 的 pino 透传项（redact / transport）。
 *
 * - 生产 + 配了 loki：多目标 transport（`pino/file` 落盘 + `pino-loki` 推送，带 labels 与批量间隔）；
 * - 非生产 / 未配 loki：不传 transport，交回 `createLogger` 的 pretty 分支处理。
 *
 * 注意：`redact` 与 `transport` 都只能在 pino 构造时指定，故必须由这里透传；
 * kits 不再依赖 nestjs-pino / pino-http —— 那两者只负责 Nest 适配与请求日志，
 * 现在分别由 `NestLoggerAdapter` 与 `apps/server` 的 `RequestLoggerMiddleware` 承担。
 *
 * ⚠️ `pino-loki` 依赖必须声明在 **`@repo/shared`**（创建 pino 实例的包），不能挪回 kits：
 * pino 的 transport worker 按创建实例的包解析 target，声明错位置会直接
 * `unable to determine transport target for "pino-loki"`（已实测踩过）。
 */
export const buildPinoOptions = (config: LoggerConfig): CreateLoggerOptions => {
  const pretty = resolvePretty(config)

  if (!pretty && config.loki) {
    return {
      redact: REDACT_PATHS,
      transport: {
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
      },
    }
  }

  return { redact: REDACT_PATHS }
}
