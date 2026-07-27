export const packageName = '@repo/sdk'

export type {
  AuthStrategyType,
  AuthContext,
  CredentialsManager,
  AuthStrategy,
} from './core/interfaces.js'

export { ApiClient } from './core/api.client.js'
export type { ApiClientOptions } from './core/api.client.js'

export { ServerClient } from './core/server.client.js'
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
} from './core/server.types.js'

// Strategies
export { BearerTokenStrategy } from './core/strategies/bearer-token.strategy.js'
export type { BearerTokenCredentials } from './core/strategies/bearer-token.strategy.js'
export { ApiKeyStrategy } from './core/strategies/api-key.strategy.js'
export type { ApiKeyCredentials, ApiKeyLocation } from './core/strategies/api-key.strategy.js'
export { OAuth2Strategy, OAuth2NeedsRefreshError } from './core/strategies/oauth2.strategy.js'
export type { OAuth2Credentials, OAuth2StrategyOptions } from './core/strategies/oauth2.strategy.js'
export { HmacStrategy } from './core/strategies/hmac.strategy.js'
export type {
  HmacCredentials,
  HmacAlgorithm,
  HmacStrategyOptions,
} from './core/strategies/hmac.strategy.js'

// Credentials Managers
export { LocalStorageCredentialsManager } from './core/managers/local-storage-credentials.manager.js'
export type { StorageCredentialsManagerOptions } from './core/managers/local-storage-credentials.manager.js'
export { MemoryCredentialsManager } from './core/managers/memory-credentials.manager.js'
export { CookieCredentialsManager } from './core/managers/cookie-credentials.manager.js'
export type {
  CookieCredentialsManagerOptions,
  CookieGetter,
  CookieSetter,
  CookieClearer,
} from './core/managers/cookie-credentials.manager.js'
export { EnvCredentialsManager } from './core/managers/env-credentials.manager.js'
