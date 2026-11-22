import type { ToolOutcome } from '@repo/contracts'

/** 台账行的四个状态（`docs/design/tool-effect-ledger.md`） */
export type EffectStatus = 'dispatched' | 'completed' | 'failed' | 'unknown'

/** 结论原文最多留存多少字节；超了只记大小，不留结果 */
export const MAX_EFFECT_RESULT_BYTES = 32 * 1024

/**
 * 能力分级：**复用契约里已经存在的 `risk` / `idempotent`**，不新造字段。
 *
 * - `read`：只读 / 纯计算，重跑只多花一次调用，可重跑；
 * - `write + idempotent`：写入，但服务端承诺按 `idempotencyKey` 去重，可重跑；
 * - `write + !idempotent`：**不可逆副作用**（发消息、删数据、跑命令），永不自动重跑。
 */
export interface EffectPolicy {
  risk: 'read' | 'write'
  idempotent: boolean
}

/** 是否允许在同一个 `(runId, toolCallId)` 上再执行一次 */
export const canRerun = (policy: EffectPolicy): boolean =>
  policy.risk === 'read' || policy.idempotent

/** 台账里读出来的一行（只保留判定需要的字段） */
export interface EffectRecord {
  runId: string
  toolCallId: string
  capability: string
  requestHash: string
  status: EffectStatus
  attempts: number
  deadlineAt: Date
  outcome: ToolOutcome | null
  resultBytes: number
}

/**
 * 一次调用该怎么处置。
 *
 * `proceed` 由调用方真正去执行；`replay` 直接返回历史结论；`blocked` 返回一条明确失败
 * （**不是**「假装成功」，也**不是**「假装失败」）。
 */
export type EffectDecision =
  | { kind: 'proceed'; attempt: 'first' | 'retry' }
  | { kind: 'replay'; outcome: ToolOutcome }
  | { kind: 'blocked'; reason: EffectBlockedReason; message: string }

export type EffectBlockedReason =
  | 'effect-in-flight'
  | 'effect-unknown'
  | 'effect-conflict'
  | 'effect-result-unavailable'

/**
 * **纯判定**：同一句柄 + 同一份参数 + 历史状态 + 现有时间 → 该干什么。
 *
 * 规则只有一条主轴：**不可逆的副作用永不自动重跑**；只读与幂等写可以重跑。
 * 判不了的（派发后过期、没结论）一律如实报 `unknown`，交给上层（模型 / 人）核验，
 * 不猜成成功、也不猜成失败。
 */
export const decideEffect = (
  existing: EffectRecord | null,
  now: number,
  policy: EffectPolicy,
  requestHash: string,
): EffectDecision => {
  if (!existing) return { kind: 'proceed', attempt: 'first' }
  const rerunnable = canRerun(policy)

  // 同一个句柄换了参数 = 上下文被改写（或句柄复用），既不是重放也不是新调用，直接拦下
  if (existing.requestHash !== requestHash) {
    return {
      kind: 'blocked',
      reason: 'effect-conflict',
      message:
        '同一次调用的参数和首次不一致，为了避免执行一个没有被记录过的副作用，本次调用被拒绝；请作为一次新调用重新发起。',
    }
  }

  if (existing.status === 'completed') {
    if (existing.outcome) return { kind: 'replay', outcome: existing.outcome }
    return rerunnable
      ? { kind: 'proceed', attempt: 'retry' }
      : {
          kind: 'blocked',
          reason: 'effect-result-unavailable',
          message:
            '这次操作已经执行成功，但结果超过留存上限没有保存。请用只读能力核验实际结果，不要重复执行同一个写操作。',
        }
  }

  if (existing.status === 'failed') {
    // 不可逆动作失败也不重跑：失败可能发生在「请求已发出、响应没回来」之后
    if (rerunnable) return { kind: 'proceed', attempt: 'retry' }
    if (existing.outcome) return { kind: 'replay', outcome: existing.outcome }
    return {
      kind: 'blocked',
      reason: 'effect-result-unavailable',
      message:
        '这次操作上一次以失败告终，但失败结论没有留存。请用只读能力核验实际状态，不要重复执行同一个写操作。',
    }
  }

  if (existing.status === 'unknown') {
    return rerunnable
      ? { kind: 'proceed', attempt: 'retry' }
      : {
          kind: 'blocked',
          reason: 'effect-unknown',
          message:
            '这次操作已经派发给外部服务，但没有拿到结论（可能已经生效）。为了不重复产生副作用，这里不会自动重跑；请用只读能力核验后再决定下一步。',
        }
  }

  // dispatched：还没超过结算期限就是「有人正在执行」
  if (now < existing.deadlineAt.getTime()) {
    return {
      kind: 'blocked',
      reason: 'effect-in-flight',
      message: '这次操作正在执行中，同一个调用不会重复派发。',
    }
  }
  return rerunnable
    ? { kind: 'proceed', attempt: 'retry' }
    : {
        kind: 'blocked',
        reason: 'effect-unknown',
        message:
          '这次操作派发后超时且没有拿到结论（可能已经生效）。为了不重复产生副作用，这里不会自动重跑；请用只读能力核验后再决定下一步。',
      }
}
