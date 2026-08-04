import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { JwtService } from '../src/infra/jwt.service.js'
import { runEffect } from './helpers/integration.js'

describe('JwtService', () => {
  it('signs and verifies with the configured secret', async () => {
    const payload = await runEffect(
      Effect.map(JwtService, (jwt) => {
        const token = jwt.sign({ sub: 'jwt-user' })
        return jwt.verify<{ sub: string }>(token)
      }),
    )
    expect(payload.sub).toBe('jwt-user')
  })
})
