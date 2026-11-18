import { randomUUID } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import type { CapabilityTaskSnapshot, ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { ToolWorkerService } from './worker.service.js'

interface TaskRecord {
  id: string
  state: 'running' | 'succeeded' | 'failed' | 'canceled'
  createdAt: number
  canceled: boolean
  outcome?: ToolOutcome
  promise: Promise<void>
}

/**
 * 长耗时执行的进程内任务表（协议 §9 / §10）。
 *
 * 口径：
 * - 任务状态**只在进程内**：进程重启 = 任务丢失（`get` 返回 `expired`），脚手架期接受；
 * - `cancel` 只标记取消、丢弃结果——底层命令没有中断信号，这是已知限制；
 * - 结果保留 `RESULT_TTL_MS`，过期的任务在 `get` 时按 `expired` 处理，不占内存。
 */
const RESULT_TTL_MS = 7 * 24 * 3_600_000

@Injectable()
export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>()

  constructor(@Inject(ToolWorkerService) private readonly service: ToolWorkerService) {}

  /** 起一个任务，最多等 `waitMs`；没跑完就把句柄交回去 */
  async start(request: ToolInvokeRequest, waitMs: number): Promise<CapabilityTaskSnapshot> {
    this.sweep()
    const id = `task-${randomUUID()}`
    const record: TaskRecord = {
      id,
      state: 'running',
      createdAt: Date.now(),
      canceled: false,
      promise: Promise.resolve(),
    }
    record.promise = this.service
      .execute(request)
      .then((outcome) => {
        if (record.canceled) return
        record.outcome = outcome
        record.state = outcome.ok ? 'succeeded' : 'failed'
      })
      .catch((error: unknown) => {
        if (record.canceled) return
        record.state = 'failed'
        record.outcome = {
          ok: false,
          reason: 'executor-error',
          message: error instanceof Error ? error.message : String(error),
        }
      })
    this.tasks.set(id, record)
    await this.waitFor(record, waitMs)
    return this.view(record)
  }

  /** 查任务；`waitMs` 是长轮询窗口 */
  async get(taskId: string, waitMs = 0): Promise<CapabilityTaskSnapshot> {
    this.sweep()
    const record = this.tasks.get(taskId)
    if (!record) return { version: 1, id: taskId, state: 'expired' }
    if (record.state === 'running' && waitMs > 0) await this.waitFor(record, waitMs)
    return this.view(record)
  }

  /** 取消：幂等；已终态时返回当前快照 */
  async cancel(taskId: string): Promise<CapabilityTaskSnapshot> {
    const record = this.tasks.get(taskId)
    if (!record) return { version: 1, id: taskId, state: 'expired' }
    if (record.state === 'running') {
      record.canceled = true
      record.state = 'canceled'
    }
    return this.view(record)
  }

  private async waitFor(record: TaskRecord, waitMs: number): Promise<void> {
    if (record.state !== 'running' || waitMs <= 0) return
    await Promise.race([
      record.promise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs)
        timer.unref?.()
      }),
    ])
  }

  private view(record: TaskRecord): CapabilityTaskSnapshot {
    if (record.state === 'succeeded') {
      const outcome = record.outcome
      return {
        version: 1,
        id: record.id,
        state: 'succeeded',
        result: { ok: true, data: outcome?.ok ? outcome.data : null },
      }
    }
    if (record.state === 'failed') {
      const outcome = record.outcome
      return {
        version: 1,
        id: record.id,
        state: 'failed',
        error:
          outcome && !outcome.ok
            ? { reason: outcome.reason, message: outcome.message }
            : { reason: 'executor-error', message: '执行失败' },
      }
    }
    return {
      version: 1,
      id: record.id,
      state: record.state,
      data: { running: record.state === 'running', elapsedMs: Date.now() - record.createdAt },
    }
  }

  /** 清掉超过保留期的终态任务 */
  private sweep(): void {
    const cutoff = Date.now() - RESULT_TTL_MS
    for (const [id, record] of this.tasks) {
      if (record.state !== 'running' && record.createdAt < cutoff) this.tasks.delete(id)
    }
  }
}
