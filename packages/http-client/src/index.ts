export const packageName = '@repo/http-client'

export type {
  AuthStrategyType,
  AuthContext,
  HttpRequestConfig,
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

// ========== SSE 客户端（请求 + 流式推送） ==========
export { HttpStreamClient } from './stream/stream-client.js'
export type { StreamClientOptions } from './stream/types.js'
export type {
  StreamMessage,
  StreamClientState,
  StreamEventHandler,
} from './stream/types.js'
export { StreamClientError, StreamTransportError } from './stream/errors.js'
export { StreamParser } from './stream/stream-parser.js'
export type { StreamParseCallbacks } from './stream/stream-parser.js'
export { streamConnectOnce } from './stream/stream-transport.js'
export type {
  StreamConnection,
  StreamConnectRequest,
  StreamConnectionCallbacks,
} from './stream/stream-transport.js'
