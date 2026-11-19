import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import { ConversationEntity } from '@repo/db'

/**
 * 会话 → 工作区的解析（能力侧）。
 *
 * 能力调用只带 `conversationId`；工作区 id 在 `conversations.workspace_id` 上。
 * 按会话查一次并缓存 30s，避免每条命令都打库。
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
}
