import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import { ConversationEntity } from '@repo/db'

/**
 * 会话 → 工作区的解析（执行面改造的过渡层）。
 *
 * 能力调用只带 `conversationId`；工作区 id 在 `conversations.workspace_id` 上。
 * 这里按会话查一次并缓存 30s，避免每条 bash / file 调用都打一次库。
 *
 * 子会话共享父工作区：调用方传的是 `workspaceConversationId`（父会话 id），拿到的就是父会话的工作区。
 */
@Injectable()
export class WorkspaceLocator {
  private readonly cache = new Map<string, { id: string; at: number }>()

  constructor(@Inject(Db) private readonly db: Db) {}

  async workspaceIdOf(conversationId: string): Promise<string | null> {
    const cached = this.cache.get(conversationId)
    if (cached && Date.now() - cached.at < 30_000) return cached.id
    const row = await this.db
      .getRepository(ConversationEntity)
      .findOne({ where: { id: conversationId }, select: { id: true, workspaceId: true } })
    const workspaceId = row?.workspaceId ?? null
    if (workspaceId) this.cache.set(conversationId, { id: workspaceId, at: Date.now() })
    return workspaceId
  }

  /** 会话绑定工作区后清缓存（main 侧不需要，能力侧只读） */
  invalidate(conversationId: string): void {
    this.cache.delete(conversationId)
  }
}
