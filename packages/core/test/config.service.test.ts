import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  ConfigService,
  makeConfigLayer,
  type AppConfigInput,
} from '../src/infra/config.service.js'
import { testConfig } from './helpers/integration.js'

describe('ConfigService', () => {
  it('validates hardcoded config and applies defaults', async () => {
    const config = await Effect.runPromise(
      ConfigService.pipe(Effect.provide(makeConfigLayer(testConfig))),
    )
    expect(config.auth.passwordHashRounds).toBe(4)
    expect(config.storage.provider).toBe('s3')
  })

  it('fails its layer for invalid config', async () => {
    const invalid = {
      ...testConfig,
      db: { url: '' },
    } as AppConfigInput
    const exit = await Effect.runPromiseExit(
      ConfigService.pipe(Effect.provide(makeConfigLayer(invalid))),
    )
    expect(exit._tag).toBe('Failure')
  })
})
