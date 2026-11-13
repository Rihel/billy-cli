import { z } from 'zod'

/** 日志级别（对齐 pino） */
export type LoggerLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/** Loki 推送配置（仅生产环境且配置了 loki 时启用） */
export const LokiConfigSchema = z.object({
  host: z.string().describe('Loki 地址，如 http://localhost:31000'),
  labels: z.record(z.string(), z.string()).default({}).describe('附加标签'),
  batchInterval: z.number().int().positive().default(5000).describe('批量推送间隔（毫秒）'),
})

export type LokiConfig = z.infer<typeof LokiConfigSchema>

/**
 * 日志组件配置（对齐 rihel-base 的 logger 配置分片）：
 * - `prefix`：映射 pino 的 `name` 与 Loki 的 `labels.app`；
 * - `level`：日志级别；
 * - `pretty`：是否彩色美化输出；缺省按 `NODE_ENV !== 'production'` 推断；
 * - `loki`：生产环境下的 Loki 推送目标（开发环境忽略）。
 */
export const LoggerConfigSchema = z.object({
  prefix: z.string().default('app'),
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  pretty: z.boolean().optional(),
  loki: LokiConfigSchema.optional(),
})

export type LoggerConfig = z.infer<typeof LoggerConfigSchema>

/** DI 注入 token（LoggerConfig 是纯类型，用 Symbol 作运行时标识） */
export const LoggerConfig = Symbol.for('LoggerConfig')

/** 解析最终是否启用 pretty（显式配置优先，否则非生产即美化） */
export const resolvePretty = (config: LoggerConfig): boolean =>
  config.pretty ?? process.env.NODE_ENV !== 'production'
