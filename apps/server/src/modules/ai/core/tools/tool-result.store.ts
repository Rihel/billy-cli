import { Inject, Injectable } from '@nestjs/common'
import { TIMELINE_REPOSITORY } from './tool.config.ports.js'

/**
 * 回取用到的**只读端口**（结构化类型）。
 *
 * 为什么不 import `runtime/timeline.repository`：`core`（引擎）不该依赖 `runtime`（会话运行这个"东西"）；
 * 引擎只需要"能按会话 + 工具调用 id 取回原文"这一件事，用结构化类型声明它，
 * 由装配层把 `TimelineRepository` 绑到这个 token 上（`useExisting`，见 `ai.module.ts`）。
 */
export interface ToolResultTimelinePort {
  findToolOutput(conversationId: string, toolCallId: string): Promise<string | null>
}

/**
 * 分页句柄的**回取**存储（设计 §5.6）。
 *
 * 两级，都不新增持久化：
 * 1. **同轮**：进程内内存 —— 必须有这一层，因为运行时是**整轮结束后**才把工具出参落时间线
 *    （`tools/planner/planner.store.ts` 的注释记过这个事实），同轮里模型要下一页时库里还没有；
 * 2. **跨轮 / 跨实例**：按 `(会话, toolCallId)` 查时间线原文 —— 原文永久保留，是兜底也是真相。
 *
 * 为什么不用 Redis：一轮的 run 粘在一个实例上（会话并发由 `runs` 的部分唯一索引挡住），
 * 同轮不会跨实例；跨轮走时间线即可。少一个存储依赖，少一处不一致。
 */
const MAX_ENTRIES = 200

/**
 * 单进程内存上限（字节）。条数限制挡不住"每条都很大"：
 * 工具出参可以有 MB 级，200 条全文就可能吃掉数百 MB。字节预算才是主约束，条数兜底。
 */
const MAX_BYTES = 32 * 1024 * 1024

@Injectable()
export class ToolResultStore {
  /** `conversationId:toolCallId` → 序列化后的完整出参 */
  private readonly memory = new Map<string, string>()
  /** 当前内存里保存的序列化字节总数（UTF-8），用于字节预算淘汰 */
  private totalBytes = 0

  constructor(@Inject(TIMELINE_REPOSITORY) private readonly timelines: ToolResultTimelinePort) {}

  /** 记下这次调用的完整出参（网关的 `paginate` 插件调用） */
  remember(conversationId: string, toolCallId: string, serialized: string): void {
    const key = this.key(conversationId, toolCallId)
    const bytes = Buffer.byteLength(serialized, 'utf8')

    const previous = this.memory.get(key)
    if (previous !== undefined) {
      this.memory.delete(key)
      this.totalBytes -= Buffer.byteLength(previous, 'utf8')
    }
    this.memory.set(key, serialized)
    this.totalBytes += bytes

    // 先进先出淘汰：条数或字节任一超限就继续删最旧的（Map 保序）
    while (this.memory.size > MAX_ENTRIES || this.totalBytes > MAX_BYTES) {
      const oldest = this.memory.keys().next().value
      if (oldest === undefined) break
      const removed = this.memory.get(oldest)
      this.memory.delete(oldest)
      if (removed !== undefined) this.totalBytes -= Buffer.byteLength(removed, 'utf8')
    }
    if (this.totalBytes < 0) this.totalBytes = 0
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
