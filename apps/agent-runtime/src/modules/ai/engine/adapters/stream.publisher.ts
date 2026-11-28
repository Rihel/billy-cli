import { Inject, Injectable } from '@nestjs/common'
import { AgentStreamStore } from '../../runtime/stream/stream-store.service.js'
import type { StreamPublisher } from '../ports.js'

/**
 * 流接缝适配器：转发到现有 `AgentStreamStore`。
 *
 * 为什么不直接让 `AgentStreamStore implements StreamPublisher`：runtime 层不应该
 * 反向 import engine 的端口定义（engine 已依赖 runtime 的上下文 / 录制器类型）。
 * 适配器把依赖方向固定在 engine → runtime。
 */
@Injectable()
export class StreamPublisherAdapter implements StreamPublisher {
  constructor(@Inject(AgentStreamStore) private readonly store: AgentStreamStore) {}

  bindClient(runId: string, clientId: string): Promise<void> {
    return this.store.bindClient(runId, clientId)
  }

  startRun(runId: string, patch: Parameters<AgentStreamStore['startRun']>[1]): Promise<void> {
    return this.store.startRun(runId, patch)
  }

  patchRun(runId: string, patch: Parameters<AgentStreamStore['patchRun']>[1]): Promise<void> {
    return this.store.patchRun(runId, patch)
  }

  readRun(runId: string) {
    return this.store.readRun(runId)
  }

  clearRun(runId: string): Promise<void> {
    return this.store.clearRun(runId)
  }

  appendEvent(runId: string, event: unknown): Promise<number> {
    return this.store.appendEvent(runId, event)
  }

  appendEvents(runId: string, events: readonly unknown[]): Promise<number> {
    return this.store.appendEvents(runId, events)
  }

  readEvents(runId: string, fromRev: number) {
    return this.store.readEvents(runId, fromRev)
  }

  readAllEvents(runId: string) {
    return this.store.readAllEvents(runId)
  }

  publishEvent(runId: string, event: unknown): Promise<void> {
    return this.store.publishEvent(runId, event)
  }

  publishEvents(runId: string, events: readonly unknown[]): Promise<number> {
    return this.store.publishEvents(runId, events)
  }

  subscribeStop(runId: string, onStop: () => void): Promise<() => void> {
    return this.store.subscribeStop(runId, onStop)
  }

  publishStop(runId: string): Promise<void> {
    return this.store.publishStop(runId)
  }

  waitForReplayGate(runId: string): Promise<void> {
    return this.store.waitForReplayGate(runId)
  }

  beginReplay(runId: string): Promise<void> {
    return this.store.beginReplay(runId)
  }

  endReplay(runId: string): Promise<void> {
    return this.store.endReplay(runId)
  }

  clearEvents(runId: string): Promise<void> {
    return this.store.clearEvents(runId)
  }
}
