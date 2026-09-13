import { Inject, Injectable, Scope } from '@nestjs/common'
import { INQUIRER } from '@nestjs/core'
import { PinoLogger } from 'nestjs-pino'

/**
 * 可注入的应用日志器（对齐 rihel-base 的 AppLogger）。
 *
 * - 底层是 nestjs-pino 的 `PinoLogger`（与 pino-http 请求日志共用同一 pino 实例与 transport）；
 * - `Scope.TRANSIENT` + `@Inject(INQUIRER)`：每个宿主类拿到自己的实例，
 *   context 自动取宿主类名（无需手写 `setContext`）；
 * - 调用签名沿用 billy-cli 既有习惯 `(message, data?)`：`data` 为普通对象时并入结构化字段，
 *   非对象则放在 `data` 字段下；这样既能写 `logger.info('msg', { id })` 也能写 `logger.info('msg')`。
 */
export interface IAppLogger {
  /** 覆盖 context（默认是宿主类名） */
  setContext(context: string): void
  debug(message?: string, data?: unknown): void
  /** 等价 info（兼容既有 log 调用） */
  log(message?: string, data?: unknown): void
  info(message?: string, data?: unknown): void
  warn(message?: string, data?: unknown): void
  error(message?: string, data?: unknown): void
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * pino 保留字段：业务 data 里若同名（如 `{ name }`）会覆盖 pino 的 logger name / context，
 * 这类键改为原样收进 `data` 子对象，避免污染日志骨架字段。
 */
const RESERVED_KEYS = new Set([
  'name',
  'msg',
  'level',
  'time',
  'pid',
  'hostname',
  'context',
])

@Injectable({ scope: Scope.TRANSIENT })
export class AppLogger implements IAppLogger {
  private context: string

  constructor(
    // INQUIRER 由 Nest 注入「请求注入方」，即宿主类实例，用于取类名做 context
    @Inject(INQUIRER) private readonly parentClass: object,
    @Inject(PinoLogger) private readonly pinoLogger: PinoLogger,
  ) {
    this.context = this.parentClass?.constructor?.name || 'App'
  }

  setContext(context: string): void {
    this.context = context
  }

  debug(message?: string, data?: unknown): void {
    this.write('debug', message, data)
  }

  log(message?: string, data?: unknown): void {
    this.write('info', message, data)
  }

  info(message?: string, data?: unknown): void {
    this.write('info', message, data)
  }

  warn(message?: string, data?: unknown): void {
    this.write('warn', message, data)
  }

  error(message?: string, data?: unknown): void {
    this.write('error', message, data)
  }

  private write(
    level: 'debug' | 'info' | 'warn' | 'error',
    message?: string,
    data?: unknown,
  ): void {
    const meta: Record<string, unknown> = { context: this.context }
    if (data !== undefined) {
      if (isPlainObject(data)) {
        const kept: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(data)) {
          if (RESERVED_KEYS.has(key)) kept[key] = value
          else meta[key] = value
        }
        if (Object.keys(kept).length > 0) meta.data = kept
      } else {
        meta.data = data
      }
    }
    this.pinoLogger[level](meta, message)
  }
}
