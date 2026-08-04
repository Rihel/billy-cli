import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { PasswordService } from '../src/infra/password.service.js'
import { runEffect } from './helpers/integration.js'

describe('PasswordService', () => {
  it('hashes and verifies using the configured bcrypt rounds', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const password = yield* PasswordService
        const hash = yield* password.hash('secret12')
        return {
          hash,
          valid: yield* password.verify('secret12', hash),
          invalid: yield* password.verify('wrong', hash),
        }
      }),
    )
    expect(result.hash).not.toBe('secret12')
    expect(result.valid).toBe(true)
    expect(result.invalid).toBe(false)
  })
})
