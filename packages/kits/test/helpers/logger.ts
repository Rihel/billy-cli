import type { AppLogger } from '../../src/foundation/logger/app-logger.js'

/**
 * 单测用静默日志器：单测里直接用 `new` 构造 provider，构造器需要 AppLogger；
 * 这里给一个满足签名且不产生输出噪声的替身。
 */
export const testLogger = (): AppLogger =>
  ({
    setContext: () => {},
    debug: () => {},
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }) as unknown as AppLogger
