import type { ConfigService } from '@nestjs/config'
import type { ServerAppConfig } from './app-config.js'

/**
 * 应用级业务配置：即应用配置的 `server` 分片（端口、认证业务策略、限流等）。
 *
 * 不属于 kits 能力配置，由本应用自行定义，但**取值统一来自 app-config 加载并校验过的应用配置**，
 * 不再各处直接读 `process.env`。字段含义与默认值见 `app-config.ts` 的 `serverAppConfigSchema.server`。
 */
export type ServerConfig = ServerAppConfig['server']

/**
 * 取应用级业务配置。
 *
 * 值由 bootstrap 首行的 `loadServerAppConfig()` 加载 + 校验 + 补默认值，再经 `AppConfigModule`
 * 接进全局 `ConfigService`；各消费方注入 `ConfigService` 后惰性取自己的分片，无需额外的配置 bean。
 * 用 `getOrThrow` 而不是 `get`：走到这里说明配置已加载，缺失即是装配错误，不应静默拿到 undefined。
 */
export const resolveServerConfig = (config: ConfigService): ServerConfig =>
  config.getOrThrow<ServerConfig>('server')
