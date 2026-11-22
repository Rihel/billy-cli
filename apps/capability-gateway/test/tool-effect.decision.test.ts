import { describe, expect, it } from 'vitest'
import type { ToolOutcome } from '@repo/contracts'
import {
  MAX_EFFECT_RESULT_BYTES,
  canRerun,
  decideEffect,
  type EffectPolicy,
  type EffectRecord,
} from '../src/effects/tool-effect.types.js'

const NOW = 1_800_000_000_000

const record = (over: Partial<EffectRecord> = {}): EffectRecord => ({
  runId: 'run-1',
  toolCallId: 'call-1',
  capability: 'bash',
  requestHash: 'same-hash',
  status: 'dispatched',
  attempts: 1,
  deadlineAt: new Date(NOW + 30_000),
  outcome: null,
  resultBytes: 0,
  ...over,
})

const irreversible: EffectPolicy = { risk: 'write', idempotent: false }
const idempotentWrite: EffectPolicy = { risk: 'write', idempotent: true }
const readOnly: EffectPolicy = { risk: 'read', idempotent: false }
const okOutcome: ToolOutcome = { ok: true, data: { done: true } }
const failOutcome: ToolOutcome = {
  ok: false,
  reason: 'service-unavailable',
  message: '连接失败',
  retryable: true,
}

describe('副作用台账的纯判定', () => {
  it('没有记录 = 首次派发', () => {
    expect(decideEffect(null, NOW, irreversible, 'same-hash')).toEqual({
      kind: 'proceed',
      attempt: 'first',
    })
  })

  it('可重跑的条件只有两个：只读，或声明了幂等', () => {
    expect(canRerun(readOnly)).toBe(true)
    expect(canRerun(idempotentWrite)).toBe(true)
    expect(canRerun(irreversible)).toBe(false)
  })

  it('已完成：重复调用直接复用历史结论，不再执行', () => {
    for (const policy of [irreversible, idempotentWrite, readOnly]) {
      expect(
        decideEffect(record({ status: 'completed', outcome: okOutcome }), NOW, policy, 'same-hash'),
      ).toEqual({ kind: 'replay', outcome: okOutcome })
    }
  })

  it('已失败：可重跑的能力可以再来一次，不可逆的复用失败结论', () => {
    const failed = record({ status: 'failed', outcome: failOutcome })
    expect(decideEffect(failed, NOW, readOnly, 'same-hash')).toEqual({
      kind: 'proceed',
      attempt: 'retry',
    })
    expect(decideEffect(failed, NOW, idempotentWrite, 'same-hash')).toEqual({
      kind: 'proceed',
      attempt: 'retry',
    })
    expect(decideEffect(failed, NOW, irreversible, 'same-hash')).toEqual({
      kind: 'replay',
      outcome: failOutcome,
    })
  })

  it('正在执行（未过结算期限）：不重复派发', () => {
    const decision = decideEffect(record(), NOW, readOnly, 'same-hash')
    expect(decision.kind).toBe('blocked')
    if (decision.kind === 'blocked') expect(decision.reason).toBe('effect-in-flight')
  })

  it('不可逆动作派发后超时：报 unknown，绝不自动重跑', () => {
    const expired = record({ deadlineAt: new Date(NOW - 1) })
    const decision = decideEffect(expired, NOW, irreversible, 'same-hash')
    expect(decision.kind).toBe('blocked')
    if (decision.kind === 'blocked') expect(decision.reason).toBe('effect-unknown')
  })

  it('只读 / 幂等写派发后超时：允许重试', () => {
    const expired = record({ deadlineAt: new Date(NOW - 1) })
    expect(decideEffect(expired, NOW, readOnly, 'same-hash')).toEqual({
      kind: 'proceed',
      attempt: 'retry',
    })
    expect(decideEffect(expired, NOW, idempotentWrite, 'same-hash')).toEqual({
      kind: 'proceed',
      attempt: 'retry',
    })
  })

  it('不可逆动作的失败结论丢失：报结果不可用，不猜成功也不猜失败', () => {
    const lost = record({ status: 'completed', resultBytes: MAX_EFFECT_RESULT_BYTES + 1 })
    const decision = decideEffect(lost, NOW, irreversible, 'same-hash')
    expect(decision.kind).toBe('blocked')
    if (decision.kind === 'blocked') expect(decision.reason).toBe('effect-result-unavailable')
    // 只读能力遇到同样情况可以重跑（代价只是一次查询）
    expect(decideEffect(lost, NOW, readOnly, 'same-hash')).toEqual({
      kind: 'proceed',
      attempt: 'retry',
    })
  })

  it('同一句柄换了参数：判为冲突', () => {
    const decision = decideEffect(
      record({ status: 'completed', outcome: okOutcome }),
      NOW,
      readOnly,
      'other-hash',
    )
    expect(decision.kind).toBe('blocked')
    if (decision.kind === 'blocked') expect(decision.reason).toBe('effect-conflict')
  })

  it('不可逆动作即使上次判了可重试，也不重跑', () => {
    const failed = record({ status: 'failed', outcome: failOutcome })
    expect(decideEffect(failed, NOW, irreversible, 'same-hash')).toEqual({
      kind: 'replay',
      outcome: failOutcome,
    })
  })
})
