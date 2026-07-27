export const packageName = '@repo/sdk'

export type {
  AuthStrategyType,
  AuthContext,
  CredentialsManager,
  AuthStrategy,
} from './core/interfaces.js'

export { ApiClient } from './core/api.client.js'
export type { ApiClientOptions } from './core/api.client.js'

export { ServerClient } from './server.client.js'
export type {
  SafeUser,
  AuthResult,
  SuccessResult,
  TodoItem,
  TodoCursor,
  TodoCursorPage,
  PaginatedResult,
  StoragePresignedUrl,
  StorageCredentials,
} from './server.types.js'

// Strategies
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

// Credentials Managers
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
