export const packageName = '@repo/sdk'

export type {
  AuthStrategyType,
  AuthContext,
  CredentialsManager,
  AuthStrategy,
  CredentialProvider,
} from './core/interfaces.js'

// 核心组件
export { ApiClient } from './core/api.client.js'
export type { ApiClientOptions, RequestOptions } from './core/api.client.js'
export { CredentialResolver } from './core/credential-resolver.js'
export { AuthInjector } from './core/auth-injector.js'
export {
  ApiError,
  ApiErrorCodes,
  mapAppErrorValue,
  mapHttpStatus,
} from './core/api-error.js'

export { ServerClient } from './server.client.js'

// 认证策略
export { BearerTokenStrategy } from './strategies/bearer-token.strategy.js'
export type { BearerTokenCredentials } from './strategies/bearer-token.strategy.js'
export { ApiKeyStrategy } from './strategies/api-key.strategy.js'
export type {
  ApiKeyCredentials,
  ApiKeyLocation,
} from './strategies/api-key.strategy.js'
export {
  OAuth2Strategy,
  OAuth2NeedsRefreshError,
} from './strategies/oauth2.strategy.js'
export type {
  OAuth2Credentials,
  OAuth2StrategyOptions,
} from './strategies/oauth2.strategy.js'
export { HmacStrategy } from './strategies/hmac.strategy.js'
export type {
  HmacCredentials,
  HmacAlgorithm,
  HmacStrategyOptions,
} from './strategies/hmac.strategy.js'

// 凭证供应器
export { EmptyCheckProvider } from './providers/empty-check.provider.js'
export { ExpiresAtProvider } from './providers/expires-at.provider.js'

// 凭证管理器
export { LocalStorageCredentialsManager } from './managers/local-storage-credentials.manager.js'
export type { StorageCredentialsManagerOptions } from './managers/local-storage-credentials.manager.js'
export { MemoryCredentialsManager } from './managers/memory-credentials.manager.js'
export { CookieCredentialsManager } from './managers/cookie-credentials.manager.js'
export type {
  CookieCredentialsManagerOptions,
  CookieGetter,
  CookieSetter,
  CookieClearer,
} from './managers/cookie-credentials.manager.js'
export { EnvCredentialsManager } from './managers/env-credentials.manager.js'
