import type { AuthStrategy, AuthStrategyType, AuthContext } from '../interfaces.js'

export type BearerTokenCredentials = {
  token: string
}

export class BearerTokenStrategy implements AuthStrategy<BearerTokenCredentials> {
  type: AuthStrategyType = 'bearerToken'

  async isAuthorization(credentials: BearerTokenCredentials): Promise<boolean> {
    return !!credentials?.token
  }

  async getAuthContext(
    credentials: BearerTokenCredentials,
  ): Promise<AuthContext> {
    return {
      headers: {
        Authorization: `Bearer ${credentials.token}`,
      },
    }
  }
}
