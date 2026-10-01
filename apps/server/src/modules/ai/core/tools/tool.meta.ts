import { Injectable } from '@nestjs/common'
import type { ToolPageMeta } from './tools.types.js'

/**
 * 一次工具调用的**审计元数据**（设计 §5.11「审计与可观测」）。
 *
 * 为什么需要它：时间线上的 `tool-result` 行由流录制器从**流片段**写出来，
 * 它看得到出参，但看不到"网关为什么放行 / 为什么拒绝 / 用的是哪版配置 / 耗时多少"。
 * 网关把这些写进这个短期账本，录制器写行时按 `(runId, toolCallId)` 取走并合并进 `payload.outcome`。
 *
 * 刻意**不落库、只放进程内**：它是"写时间线那一行时的临时旁证"，时间线本身才是审计证据；
 * 崩溃恢复重放会重新产生这份旁证（同一工具调用会重新执行、重新记账）。
 */
export interface ToolCallMeta {
  ok: boolean
  /** 失败原因（`ToolDenyReason` 的取值） */
  reason?: string
  /** 配置版本（库里那行的 updatedAt；解释"重放时判定为什么不一样"） */
  configVersion: string
  durationMs: number
  /** 分页页头（出参被分页时才有） */
  page?: ToolPageMeta
  /** 出参字节数（分页与观测都要） */
  outputBytes?: number
}

/** 进程内账本（按 `runId:toolCallId` 索引；容量封顶，避免长跑进程里无界增长） */
const MAX_ENTRIES = 2_000

@Injectable()
export class ToolCallMetaStore {
  private readonly entries = new Map<string, ToolCallMeta>()

  /** 记账（网关的 `audit-end` 插件调用） */
  put(runId: string, toolCallId: string | null, meta: ToolCallMeta): void {
    if (!toolCallId) return
    const key = this.key(runId, toolCallId)
    this.entries.delete(key)
    this.entries.set(key, meta)
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  /** 取走（写时间线那一行时调用一次；取走即删，避免同一 key 被复用两次） */
  take(runId: string, toolCallId: string | null): ToolCallMeta | null {
    if (!toolCallId) return null
    const key = this.key(runId, toolCallId)
    const value = this.entries.get(key)
    if (value === undefined) return null
    this.entries.delete(key)
    return value
  }

  private key(runId: string, toolCallId: string): string {
    return `${runId}:${toolCallId}`
  }
}
