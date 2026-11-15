/**
 * 历史子 run → 子会话回填（一次性维护脚本，默认只预览）。
 *
 * 背景：子 agent = 子会话是后来落地的；更早的子 run 仍挂在**父会话**上，
 * 没有对应的 `kind='subagent'` 会话。这个脚本按 `(parent_run_id, tool_call_id)` 建子会话，
 * 并把该子 run 的 runs / timelines 迁到子会话；**不删任何数据**。
 *
 * 用法：
 *   pnpm --filter @app/agent-runtime exec tsx scripts/backfill-subconversations.ts        # 预览
 *   pnpm --filter @app/agent-runtime exec tsx scripts/backfill-subconversations.ts --apply # 执行
 *
 * 幂等：已有子会话（origin_run_id + origin_tool_call_id）的会被跳过。
 */
import 'dotenv/config'
import { Db, type AppLogger } from '@repo/kits'
import { ConversationEntity, DB_ENTITIES, RunEntity } from '@repo/db'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'

const silentLogger = {
  setContext: () => undefined,
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as AppLogger

interface OrphanGroup {
  parent_run_id: string
  tool_call_id: string
  parent_conversation_id: string
  parent_root_conversation_id: string | null
  user_id: string
  agent_key: string
  depth: number
  runs: number
}

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply')
  const db = new Db(
    {
      url: process.env.DB_URL!,
      sync: false,
      entities: DB_ENTITIES,
    } as never,
    silentLogger,
  )
  await db.onApplicationBootstrap()
  if (!db.dataSource.isInitialized) throw new Error('数据库初始化失败')

  try {
    const groups = await db.dataSource.query<OrphanGroup[]>(`
      SELECT r.parent_run_id,
             r.tool_call_id,
             r.conversation_id AS parent_conversation_id,
             c.root_conversation_id AS parent_root_conversation_id,
             c.user_id,
             r.agent_key,
             r.depth,
             COUNT(*)::int AS runs
        FROM runs r
        JOIN conversations c ON c.id = r.conversation_id
       WHERE r.parent_run_id IS NOT NULL
         AND r.tool_call_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM conversations ch
            WHERE ch.origin_run_id = r.parent_run_id
              AND ch.origin_tool_call_id = r.tool_call_id
         )
       GROUP BY r.parent_run_id, r.tool_call_id, r.conversation_id,
                c.root_conversation_id, c.user_id, r.agent_key, r.depth
       ORDER BY r.parent_run_id, r.tool_call_id
    `)

    console.log(
      `[backfill] 待回填子 run 组：${groups.length}（runs 合计 ${groups.reduce((n, g) => n + g.runs, 0)}）`,
    )
    if (!apply) {
      for (const group of groups.slice(0, 10)) {
        console.log(
          `  - parent_run=${group.parent_run_id} tool_call=${group.tool_call_id} agent=${group.agent_key} runs=${group.runs}`,
        )
      }
      console.log('[backfill] 预览模式；加 --apply 执行')
      return
    }

    const conversations = new ConversationRepository(db)
    let created = 0
    for (const group of groups) {
      const parent = await db.getRepository(ConversationEntity).findOne({
        where: { id: group.parent_conversation_id },
      })
      if (!parent) continue
      const name = group.agent_key.replace(/^sub:/, '')
      const child = await conversations.ensureSubagent({
        parent,
        name,
        agentKey: group.agent_key,
        depth: group.depth,
        originRunId: group.parent_run_id,
        originToolCallId: group.tool_call_id,
      })
      await db.transaction(async (manager) => {
        const runIds = await manager
          .createQueryBuilder(RunEntity, 'r')
          .select('r.id', 'id')
          .where('r.parent_run_id = :parentRunId', { parentRunId: group.parent_run_id })
          .andWhere('r.tool_call_id = :toolCallId', { toolCallId: group.tool_call_id })
          .getRawMany<{ id: string }>()
        const ids = runIds.map((row) => row.id)
        if (ids.length === 0) return
        await manager
          .createQueryBuilder()
          .update(RunEntity)
          .set({ conversationId: child.id })
          .whereInIds(ids)
          .execute()
        // 时间线是审计正文：跟着子 run 一起迁到子会话，不删不改内容
        await manager.query('UPDATE timelines SET conversation_id = $1 WHERE run_id = ANY($2)', [
          child.id,
          ids,
        ])
      })
      created += 1
      console.log(`[backfill] 已回填 ${group.parent_run_id}/${group.tool_call_id} → ${child.id}`)
    }
    console.log(`[backfill] 完成：新建/复用子会话 ${created} 个`)
  } finally {
    await db.close()
  }
}

void main().catch((error) => {
  console.error('[backfill] 失败', error)
  process.exitCode = 1
})
