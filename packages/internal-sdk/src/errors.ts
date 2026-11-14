/** 内部 API 调用错误：业务/调用方只该看到这四类，不去猜 fetch 的原始异常 */

/** HTTP 非 2xx（服务端明确拒绝 / 失败） */
export class InternalApiError extends Error {
  readonly name = 'InternalApiError'
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`内部接口返回 ${status}${detail ? `：${detail}` : ''}`)
  }
}

/** 连不上 / 连接被重置 / DNS 失败等传输层错误 */
export class InternalTransportError extends Error {
  readonly name = 'InternalTransportError'
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

/** 本次调用超过 deadline（由 AbortSignal.timeout 触发） */
export class InternalTimeoutError extends Error {
  readonly name = 'InternalTimeoutError'
  constructor(readonly timeoutMs: number) {
    super(`内部接口调用超时（${timeoutMs}ms）`)
  }
}

/** 调用方主动 abort（用户停止 / 上游取消） */
export class InternalAbortError extends Error {
  readonly name = 'InternalAbortError'
  constructor() {
    super('内部接口调用已取消')
  }
}

/** 响应不符合契约（字段缺失 / 类型错） */
export class InternalProtocolError extends Error {
  readonly name = 'InternalProtocolError'
  constructor(readonly issues: unknown) {
    super('内部接口响应不符合契约')
  }
}
