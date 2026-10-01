import { Inject, Injectable } from '@nestjs/common'
import { TIMELINE_REPOSITORY } from './tool.config.ports.js'
import type { TimelineRepository } from '../runtime/timeline.repository.js'

/**
 * 分页句柄的**回取**存储（设计 §5.6）。
 *
 * 两级，都不新增持久化：
 * 1. **同轮**：进程内内存 —— 必须有这一层，因为运行时是**整轮结束后**才把工具出参落时间线
 *    （`core/beans/planner/planner.store.ts` 的注释记过这个事实），同轮里模型要下一页时库里还没有；
 * 2. **跨轮 / 跨实例**：按 `(会话, toolCallId)` 查时间线原文 —— 原文永久保留，是兜底也是真相。
 *
 * 为什么不用 Redis：一轮的 run 粘在一个实例上（会话并发由 `runs` 的部分唯一索引挡住），
 * 同轮不会跨实例；跨轮走时间线即可。少一个存储依赖，少一处不一致。
 */
const MAX_ENTRIES = 200

@Injectable()
export class ToolResultStore {
  /** `conversationId:toolCallId` → 序列化后的完整出参 */
  private readonly memory = new Map<string, string>()

  constructor(@Inject(TIMELINE_REPOSITORY) private readonly timelines: TimelineRepository) {}

  /** 记下这次调用的完整出参（网关的 `paginate` 插件调用） */
  remember(conversationId: string, toolCallId: string, serialized: string): void {
    const key = this.key(conversationId, toolCallId)
    this.memory.delete(key)
    this.memory.set(key, serialized)
    if (this.memory.size > MAX_ENTRIES) {
      const oldest = this.memory.keys().next().value
      if (oldest !== undefined) this.memory.delete(oldest)
    }
  }

  /** 取回全文：先内存（同轮），再时间线（跨轮 / 跨实例 / 内存淘汰后） */
  async resolve(conversationId: string, toolCallId: string): Promise<string | null> {
    const hit = this.memory.get(this.key(conversationId, toolCallId))
    if (hit !== undefined) return hit
    const fromTimeline = await this.timelines.findToolOutput(conversationId, toolCallId)
    return fromTimeline
  }

  private key(conversationId: string, toolCallId: string): string {
    return `${conversationId}:${toolCallId}`
  }
}
