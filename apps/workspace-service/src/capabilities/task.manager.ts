import { randomUUID } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import type { CapabilityTaskSnapshot, ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { BashExecutor } from './bash.executor.js'

interface TaskRecord {
  id: string
  state: 'running' | 'succeeded' | 'failed' | 'canceled'
  createdAt: number
  canceled: boolean
  outcome?: ToolOutcome
  promise: Promise<void>
}

const RESULT_TTL_MS = 7 * 24 * 3_600_000

/**
 * 长耗时执行的进程内任务表（`bash` 的 task 形态）。
 *
 * 口径与 common-capability 一致：状态只在进程内、重启即 expired、cancel 只丢结果不中断命令。
 */
@Injectable()
export class WorkspaceTaskManager {
  private readonly tasks = new Map<string, TaskRecord>()

  constructor(@Inject(BashExecutor) private readonly bash: BashExecutor) {}

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
    record.promise = this.bash
      .bash(request)
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

  async get(taskId: string, waitMs = 0): Promise<CapabilityTaskSnapshot> {
    this.sweep()
    const record = this.tasks.get(taskId)
    if (!record) return { version: 1, id: taskId, state: 'expired' }
    if (record.state === 'running' && waitMs > 0) await this.waitFor(record, waitMs)
    return this.view(record)
  }

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
      return {
        version: 1,
        id: record.id,
        state: 'succeeded',
        result: { ok: true, data: record.outcome?.ok ? record.outcome.data : null },
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

  private sweep(): void {
    const cutoff = Date.now() - RESULT_TTL_MS
    for (const [id, record] of this.tasks) {
      if (record.state !== 'running' && record.createdAt < cutoff) this.tasks.delete(id)
    }
  }
}
