import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { AppErrorCodes } from '@repo/shared'
import { AuthService } from '../src/biz/auth.service.js'
import { UserService } from '../src/biz/user.service.js'
import { runEffect } from './helpers/integration.js'

const runUser = <A, E>(
  use: (service: UserService['Type']) => Effect.Effect<A, E>,
) => runEffect(Effect.flatMap(UserService, use))

describe('UserService with real PostgreSQL', () => {
  it('creates, reads, updates, and removes a persisted user', async () => {
    const created = await runUser((user) =>
      user.create({
        email: 'admin@example.com',
        password: 'secret12',
        realName: 'Admin',
      }),
    )
    expect(created).not.toHaveProperty('password')

    expect(
      (await runUser((user) => user.detail({ userId: created.id }))).email,
    ).toBe(created.email)
    expect(
      (
        await runUser((user) =>
          user.update({ userId: created.id, realName: 'Owner' }),
        )
      ).realName,
    ).toBe('Owner')
    expect(
      (await runUser((user) => user.remove({ userId: created.id }))).success,
    ).toBe(true)
  })

  it('rejects duplicate emails through a real transaction', async () => {
    const input = { email: 'duplicate-user@example.com', password: 'secret12' }
    await runUser((user) => user.create(input))

    const result = await runUser((user) =>
      user.create(input).pipe(Effect.either),
    )
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left')
      expect(result.left.code).toBe(AppErrorCodes.EmailTaken)
  })

  it('queries persisted users with pagination and keyword filtering', async () => {
    await runUser((user) =>
      user.create({ email: 'alpha@example.com', password: 'secret12' }),
    )
    await runUser((user) =>
      user.create({ email: 'beta@example.com', password: 'secret12' }),
    )

    const page = await runUser((user) =>
      user.pageQuery({
        page: 1,
        size: 10,
        keyword: 'alpha',
        orderBy: 'email',
        order: 'asc',
      }),
    )
    expect(page.total).toBe(1)
    expect(page.items[0].email).toBe('alpha@example.com')
    expect(page.items[0]).not.toHaveProperty('password')
  })

  it('resets the real password hash used by AuthService', async () => {
    const created = await runUser((user) =>
      user.create({ email: 'password@example.com', password: 'before12' }),
    )
    await runUser((user) =>
      user.resetPassword({ userId: created.id, password: 'after123' }),
    )

    const login = await runEffect(
      Effect.flatMap(AuthService, (auth) =>
        auth.login({ email: 'password@example.com', password: 'after123' }),
      ),
    )
    expect(login.user.id).toBe(created.id)
  })
})
