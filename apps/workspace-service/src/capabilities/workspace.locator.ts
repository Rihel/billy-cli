import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import { ConversationEntity } from '@repo/db'
import type { ToolInvokeRequest } from '@repo/contracts'

/**
 * 会话 → 工作区的解析（能力侧）。
 *
 * 能力调用只带 `conversationId`；工作区 id 在 `conversations.workspace_id` 上。
 * 按会话查一次并缓存 30s，避免每条命令都打库。
 *
 * 工作区归属在**根会话**：历史子会话的 `workspace_id` 可能是空（建模期没继承），
 * 因此本行为空时按 `root_conversation_id` 回落查根会话 —— 不改数据，直接自愈。
 */
@Injectable()
export class WorkspaceLocator {
  private readonly cache = new Map<string, { id: string; workdir: string | null; at: number }>()

  constructor(@Inject(Db) private readonly db: Db) {}

  /** 这次调用该用哪个工作区：请求里显式带的优先，否则按会话回落（子会话沿根会话） */
  async forRequest(request: ToolInvokeRequest): Promise<string | null> {
    return request.workspaceId ?? (await this.workspaceIdOf(request.caller.conversationId))
  }

  /** 会话 → 工作区 + 默认目录；子会话沿根会话取 */
  async resolve(
    conversationId: string,
  ): Promise<{ workspaceId: string; workdir: string | null } | null> {
    const cached = this.cache.get(conversationId)
    if (cached && Date.now() - cached.at < 30_000) {
      return { workspaceId: cached.id, workdir: cached.workdir }
    }
    const repo = this.db.getRepository(ConversationEntity)
    const row = await repo.findOne({
      where: { id: conversationId },
      select: { id: true, workspaceId: true, workdir: true, rootConversationId: true },
    })
    let workspaceId = row?.workspaceId ?? null
    let workdir = row?.workdir ?? null
    const rootConversationId = row?.rootConversationId ?? null
    // 本行没绑工作区但有根会话：回落根会话（子 agent 的工作区归属语义在根会话上）
    if (rootConversationId && rootConversationId !== conversationId && (!workspaceId || !workdir)) {
      const root = await repo.findOne({
        where: { id: rootConversationId },
        select: { id: true, workspaceId: true, workdir: true },
      })
      workspaceId = workspaceId ?? root?.workspaceId ?? null
      workdir = workdir ?? root?.workdir ?? null
    }
    // 只缓存命中结果：缓存 null 会让"工作区后来绑上"的会话在 30s 内一直报 no-workspace
    if (workspaceId) this.cache.set(conversationId, { id: workspaceId, workdir, at: Date.now() })
    return workspaceId ? { workspaceId, workdir } : null
  }

  async workspaceIdOf(conversationId: string): Promise<string | null> {
    return (await this.resolve(conversationId))?.workspaceId ?? null
  }

  async workdirOf(conversationId: string): Promise<string | null> {
    return (await this.resolve(conversationId))?.workdir ?? null
  }
}
