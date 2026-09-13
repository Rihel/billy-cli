import type { AppLogger } from '@repo/kits'

/** 单测用静默日志器：单测直接用 `new` 构造 service，构造器需要注入 AppLogger */
export const testLogger = (): AppLogger =>
  ({
    setContext: () => {},
    debug: () => {},
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }) as unknown as AppLogger
