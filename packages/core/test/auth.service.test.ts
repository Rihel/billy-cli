import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { AppErrorCodes } from '@repo/shared'
import { AuthService } from '../src/biz/auth.service.js'
import { runEffect } from './helpers/integration.js'

const runAuth = <A, E>(
  use: (service: AuthService['Type']) => Effect.Effect<A, E>,
) => runEffect(Effect.flatMap(AuthService, use))

describe('AuthService with real PostgreSQL', () => {
  it('registers, signs a real token, and logs in with a real password hash', async () => {
    const registered = await runAuth((auth) =>
      auth.register({
        email: 'auth@example.com',
        password: 'secret12',
        realName: 'Auth User',
      }),
    )

    expect(registered.user).not.toHaveProperty('password')
    const verified = await runAuth((auth) =>
      auth.verifyToken(registered.token),
    )
    expect(verified).toBe(registered.user.id)

    const loggedIn = await runAuth((auth) =>
      auth.login({ email: 'auth@example.com', password: 'secret12' }),
    )
    expect(loggedIn.user.id).toBe(registered.user.id)
  })

  it('rolls back registration when the email already exists', async () => {
    const input = { email: 'duplicate@example.com', password: 'secret12' }
    await runAuth((auth) => auth.register(input))

    const result = await runAuth((auth) =>
      auth.register(input).pipe(Effect.either),
    )
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left')
      expect(result.left.code).toBe(AppErrorCodes.EmailTaken)
  })

  it('persists and consumes a password reset token', async () => {
    await runAuth((auth) =>
      auth.register({ email: 'reset@example.com', password: 'before12' }),
    )
    const forgot = await runAuth((auth) =>
      auth.forgotPassword({ email: 'reset@example.com' }),
    )

    expect(forgot.token).toBeTypeOf('string')
    await runAuth((auth) =>
      auth.resetPassword({ token: forgot.token!, password: 'after123' }),
    )
    const loggedIn = await runAuth((auth) =>
      auth.login({ email: 'reset@example.com', password: 'after123' }),
    )
    expect(loggedIn.user.email).toBe('reset@example.com')
  })

  it('updates profile and changes password in PostgreSQL', async () => {
    const registered = await runAuth((auth) =>
      auth.register({ email: 'profile@example.com', password: 'before12' }),
    )

    const updated = await runAuth((auth) =>
      auth.updateInfo(registered.user.id, { realName: 'Updated User' }),
    )
    expect(updated.realName).toBe('Updated User')

    await runAuth((auth) =>
      auth.changePassword(registered.user.id, {
        oldPassword: 'before12',
        newPassword: 'after123',
      }),
    )
    expect(
      (
        await runAuth((auth) =>
          auth.login({ email: 'profile@example.com', password: 'after123' }),
        )
      ).user.id,
    ).toBe(registered.user.id)
  })

  it('rejects invalid credentials and invalid JWTs', async () => {
    await runAuth((auth) =>
      auth.register({ email: 'invalid@example.com', password: 'secret12' }),
    )

    const loginResult = await runAuth((auth) =>
      auth.login({ email: 'invalid@example.com', password: 'wrong' }).pipe(Effect.either),
    )
    expect(loginResult._tag).toBe('Left')
    if (loginResult._tag === 'Left')
      expect(loginResult.left.code).toBe(AppErrorCodes.InvalidCredentials)

    const tokenResult = await runAuth((auth) =>
      auth.verifyToken('invalid').pipe(Effect.either),
    )
    expect(tokenResult._tag).toBe('Left')
    if (tokenResult._tag === 'Left')
      expect(tokenResult.left.code).toBe(AppErrorCodes.TokenInvalid)
  })
})
