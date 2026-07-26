export type AuthStrategyType = 'apiKey' | 'oauth2' | 'bearerToken' | 'hmac'

export type AuthContext = {
  headers?: Record<string, string>
  body?: Record<string, any>
  query?: Record<string, any>
}

export interface CredentialsManager<Credentials = Record<string, any>> {
  getCredentials: () => Promise<Credentials>
  setCredentials: (credentials: Credentials) => Promise<void>
  clearCredentials: () => Promise<void>
}

export interface AuthStrategy<Credentials = Record<string, any>> {
  type: AuthStrategyType
  getAuthContext(credentials: Credentials): Promise<AuthContext>
  isAuthorization(credentials?: Credentials): Promise<boolean>
}
