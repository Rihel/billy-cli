/**
 * 流式增量的**帧级合并**（`text-delta` / `reasoning-delta` / `data-sub-agent-delta`）。
 *
 * 为什么要合并：模型每吐一个 token 就是一个片段，而每个片段在 `emitAgUi` 里都要付出一次
 * 「等补发闸门 + 写输出记录 + 定向广播 + 写响应体」的固定成本。逐 token 传输对界面没有增益 ——
 * 前端本来就是按 100ms 合并渲染的（`chat-session.ts` 的 `applyChunk`）—— 只是把 Redis 往返、
 * 带宽和主线程解析按 token 数放大。
 *
 * 做法：按「合并键」把同一段内容的增量拼成一块，攒够 `intervalMs`（默认 100ms，与前端渲染批次
 * 对齐）或 `maxChars` 再冲出去。**顺序由同一把链保证**：调用方把所有发射动作都塞进
 * {@link DeltaCoalescer.run}，冲块与"非增量块"不会互相插队。
 *
 * 不改协议：多个 `TEXT_MESSAGE_CONTENT` 合成一个，客户端本来就是累加 `delta`；
 * 补发侧的 `coalesceDeltas` 早已按同一口径合并，输出记录的形状也不变。
 */

/** 可合并的增量块类型（状态类 / 边界类块不在此列：它们各自是一条语义） */
export const COALESCED_DELTA_TYPES: ReadonlySet<string> = new Set([
  'text-delta',
  'reasoning-delta',
  'data-sub-agent-delta',
])

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * 合并键：同键的增量按到达顺序拼接；返回 `null` = 这块不能合并（缺 id / 缺子 agent 身份）。
 *
 * 键里带 `id`（文本 / 推理的 part id）与 `runId + name + kind`（子 agent 身份）：
 * 并行子 agent 的增量必须各攒各的，混成一块会把两路正文拼到一起。
 */
export const coalesceKeyOf = (chunk: unknown): string | null => {
  const record = asRecord(chunk)
  if (!record) return null
  const type = String(record.type ?? '')
  if (type === 'text-delta' || type === 'reasoning-delta') {
    const id = String(record.id ?? '')
    return id ? `${type}:${id}` : null
  }
  if (type === 'data-sub-agent-delta') {
    const data = asRecord(record.data)
    const runId = String(data?.runId ?? '')
    const kind = String(data?.kind ?? '')
    if (!runId || !kind) return null
    return `${type}:${runId}:${String(data?.name ?? '')}:${kind}`
  }
  return null
}

/** 这块能不能进合并器（类型对 + 有合并键） */
export const isCoalescedDelta = (chunk: unknown): boolean =>
  COALESCED_DELTA_TYPES.has(String(asRecord(chunk)?.type ?? '')) && coalesceKeyOf(chunk) !== null

/** 把 `next` 的正文接在 `prev` 后面（身份字段一律保留 `prev` 的） */
export const mergeDelta = (
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> => {
  const type = String(prev.type ?? '')
  if (type === 'text-delta' || type === 'reasoning-delta') {
    return { ...prev, delta: `${String(prev.delta ?? '')}${String(next.delta ?? '')}` }
  }
  // `data-sub-agent-delta`：正文在 `data.text` 里（见 AgentRunner.writeDelta）
  const prevData = asRecord(prev.data) ?? {}
  const nextData = asRecord(next.data) ?? {}
  return {
    ...prev,
    data: { ...prevData, text: `${String(prevData.text ?? '')}${String(nextData.text ?? '')}` },
  }
}

/** 块里累计的正文字数（阈值判定用；不要在热路径里 JSON.stringify） */
export const deltaCharsOf = (chunk: Record<string, unknown>): number => {
  const type = String(chunk.type ?? '')
  if (type === 'text-delta' || type === 'reasoning-delta') {
    return String(chunk.delta ?? '').length
  }
  return String(asRecord(chunk.data)?.text ?? '').length
}

export interface DeltaCoalescerOptions {
  /** 攒多久冲一次（毫秒） */
  intervalMs: number
  /** 单帧累计字数上限：超了立刻冲，避免一个长帧把 100ms 拖成好几秒 */
  maxChars: number
  /** 冲出去：批量编码 + 一次追加 + 一次广播，返回这一批的最后一个 rev */
  sink: (chunks: Array<Record<string, unknown>>) => Promise<number>
  /** 冲失败（Redis 抖动等）：调用方记日志，**不打断**用户正在看的流 */
  onError?: (error: unknown) => void
}

/**
 * 单条 run 的增量合并器。
 *
 * 生命周期由调用方持有（每个 run 一个，手工创建、不走容器）；`dispose()` 会先冲掉残余再停表。
 * 所有对外动作都经过同一条 Promise 链，因此「攒着的增量」与「立即发射的非增量块」天然有序。
 */
export class DeltaCoalescer {
  /** 合并键 → 待发块（Map 保持首次出现顺序 = 事件顺序） */
  private readonly pending = new Map<string, { chunk: Record<string, unknown>; chars: number }>()
  private timer: NodeJS.Timeout | null = null
  private chain: Promise<void> = Promise.resolve()
  private disposed = false
  private lastRev = 0

  constructor(private readonly options: DeltaCoalescerOptions) {}

  /** 已经冲出去的最后一个 rev（进度展示用；比真实水位最多落后一个 interval） */
  get rev(): number {
    return this.lastRev
  }

  /** 收下一个增量块：能合并就合并，够量立刻冲（不 await，调用方不等网络） */
  push(chunk: unknown): void {
    if (this.disposed) return
    const key = coalesceKeyOf(chunk)
    const next = asRecord(chunk)
    if (key === null || !next) return
    const existing = this.pending.get(key)
    if (existing) {
      existing.chunk = mergeDelta(existing.chunk, next)
      existing.chars = deltaCharsOf(existing.chunk)
    } else {
      this.pending.set(key, { chunk: { ...next }, chars: deltaCharsOf(next) })
    }
    this.arm()
    if (this.totalChars() >= this.options.maxChars) void this.flush()
  }

  /**
   * 冲掉当前缓冲（串行化：与其它 {@link run} 任务按调用顺序排队）。
   *
   * **不会 reject**：冲块失败只记日志（`onError`），不能把正在给用户看的流打断；
   * 定时器路径是 `void flush()`，reject 会变成进程级未处理拒绝。
   */
  flush(): Promise<void> {
    return this.run(async () => {
      if (this.pending.size === 0) return
      const chunks = [...this.pending.values()].map((item) => item.chunk)
      this.pending.clear()
      const rev = await this.options.sink(chunks)
      if (rev > this.lastRev) this.lastRev = rev
    }).then(
      () => undefined,
      () => undefined,
    )
  }

  /** 把一个发射动作排进同一条链（保证相对增量的顺序） */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task)
    // 链本身只关心"排到哪儿了"：上一个任务失败不能把后续全卡死
    this.chain = result.then(
      () => undefined,
      (error: unknown) => {
        this.options.onError?.(error)
      },
    )
    return result
  }

  /** 先冲掉残余再停表（幂等；之后到达的 push 直接丢弃 —— 那时这一轮已经收尾） */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.flush()
  }

  private arm(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.flush()
    }, this.options.intervalMs)
    this.timer.unref?.()
  }

  private totalChars(): number {
    let total = 0
    for (const item of this.pending.values()) total += item.chars
    return total
  }
}
