import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { LoggerService } from '../src/infra/logger.service.js'
import { runEffect } from './helpers/integration.js'

describe('LoggerService', () => {
  it('provides a working configured logger', async () => {
    const methods = await runEffect(
      Effect.map(LoggerService, (logger) => {
        logger.info('integration logger test', { source: 'core' })
        return [logger.log, logger.info, logger.warn, logger.error]
      }),
    )
    expect(methods.every((method) => typeof method === 'function')).toBe(true)
  })
})
