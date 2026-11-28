import { describe, expect, it } from 'vitest'
import { AppError } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'
import {
  AgentUnavailableError,
  ConversationBusyError,
  ContextTooLongError,
  RunNotSuspendedError,
} from '../src/modules/ai/foundation/errors.js'
import { EngineError, engineError, toEngineError } from '../src/modules/ai/engine/engine-errors.js'

describe('引擎错误映射', () => {
  it('业务错误码原样翻译成协议码，HTTP 状态沿用字典', () => {
    const busy = toEngineError(new ConversationBusyError('conv_1'))
    expect(busy.code).toBe('conversation_busy')
    expect(busy.http).toBe(409)

    const unavailable = toEngineError(new AgentUnavailableError())
    expect(unavailable.code).toBe('agent_unavailable')
    expect(unavailable.http).toBe(503)

    const tooLong = toEngineError(new ContextTooLongError(120_000))
    expect(tooLong.code).toBe('context_too_long')

    const notSuspended = toEngineError(new RunNotSuspendedError('run_1'))
    expect(notSuspended.code).toBe('run_not_resumable')
    expect(notSuspended.http).toBe(409)
  })

  it('未知错误归 engine_internal，不吞原始 message', () => {
    const mapped = toEngineError(new Error('数据库连接断了'))
    expect(mapped.code).toBe('engine_internal')
    expect(mapped.http).toBe(500)
    expect(mapped.message).toBe('数据库连接断了')
  })

  it('已经是 EngineError 时原样返回；错误体带 runId / retryable', () => {
    const original = engineError('model_failed', '上游 502', { runId: 'run_1', retryable: true })
    expect(toEngineError(original)).toBe(original)
    expect(original.toBody()).toEqual({
      code: 'model_failed',
      message: '上游 502',
      runId: 'run_1',
      retryable: true,
    })
  })

  it('AppError 的子类按 code 映射，不按 message 猜', () => {
    class Custom extends AppError {
      readonly code = AppErrorCodes.ProviderRateLimited
    }
    const mapped = toEngineError(new Custom('限流'))
    expect(mapped.code).toBe('model_failed')
    expect(mapped.retryable).toBe(true)
    expect(mapped).toBeInstanceOf(EngineError)
  })
})
