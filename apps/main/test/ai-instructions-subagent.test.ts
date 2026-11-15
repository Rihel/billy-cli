import { describe, expect, it, vi } from 'vitest'
import type { ConversationEntity } from '@repo/db'
import { AppLogger, requestContext } from '@repo/kits'
import type { AgentInstructionsModel } from '@repo/shared'
import { AiAdminConversationService } from '../src/modules/ai-admin/conversation/conversation.service.js'
import type { AiConversationRepository } from '../src/modules/ai-admin/conversation/conversation.repository.js'
import type { AiRunQueryRepository } from '../src/modules/ai-admin/conversation/run-query.repository.js'
import type { AiTimelineQueryRepository } from '../src/modules/ai-admin/conversation/timeline-query.repository.js'
import type { AgentCatalogService } from '../src/agent/agent-catalog.service.js'
import type { AiModelService } from '../src/modules/ai-model/index.js'
import type { AiUsageService } from '../src/modules/ai-usage/index.js'

/**
 * 「系统指令」接口的作用域口径（2026-11-15）：
 *
 * - **快照优先**：主会话与子会话都落 `kind=system` 快照，谁有就回谁；
 * - **子会话不再查 agent 目录**：子 agent 的 agentKey 是 `sub:<名字>`，不在目录里 ——
 *   先 `resolveAgentKey` 会抛 3303（右栏与子会话页原先都栽在这条）：
 *   有快照就回快照，没有快照回 `unrecorded`（空文本、如实标注），不拿父 agent 的定义冒充。
 */

const definition: AgentInstructionsModel = {
  agentKey: 'assistant',
  name: '通用助手',
  description: '默认 agent',
  instructions: '静态定义',
  source: 'definition',
  recordedAt: null,
}

const conversation = (overrides: Record<string, unknown>): ConversationEntity =>
  ({
    id: 'conv-1',
    userId: 'user-1',
    agentKey: 'assistant',
    kind: 'root',
    title: '会话',
    fileAccess: 'workspace-write',
    ...overrides,
  }) as unknown as ConversationEntity

const createService = (input: {
  entity: ConversationEntity
  snapshot?: { text: string; agentKey: string | null; createdAt: Date } | null
}) => {
  const findEntity = vi.fn(async () => input.entity)
  const latestSystemPrompt = vi.fn(async () => input.snapshot ?? null)
  const resolveAgentKey = vi.fn(async (agentKey?: string) => agentKey ?? 'assistant')
  const instructions = vi.fn(async () => definition)
  const findAgent = vi.fn(async (agentKey: string | null | undefined) =>
    agentKey === 'assistant'
      ? { key: 'assistant', name: '通用助手', description: '默认 agent' }
      : undefined,
  )

  const service = new AiAdminConversationService(
    { findEntity } as unknown as AiConversationRepository,
    {} as AiRunQueryRepository,
    { latestSystemPrompt } as unknown as AiTimelineQueryRepository,
    { resolveAgentKey, instructions, findAgent } as unknown as AgentCatalogService,
    {} as AiUsageService,
    {} as AiModelService,
    {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as AppLogger,
  )
  return { service, findEntity, latestSystemPrompt, resolveAgentKey, instructions }
}

const asUser = <T>(run: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: 'test-request', userId: 'user-1', adminId: null }, run)

describe('系统指令接口：子助手的取数口径', () => {
  it('子会话有快照：回快照，名字取子会话标题，且不去 agent 目录里查 `sub:`', async () => {
    const { service, resolveAgentKey } = createService({
      entity: conversation({
        id: 'sub-1',
        kind: 'subagent',
        agentKey: 'sub:待办统计',
        title: '子助手：待办统计',
      }),
      snapshot: {
        text: '你是待办统计助手\n\n# 你的能力与边界（系统补充）',
        agentKey: 'sub:待办统计',
        createdAt: new Date('2026-11-15T10:00:00.000Z'),
      },
    })

    const result = await asUser(() => service.instructions({ conversationId: 'sub-1' }))

    expect(result.source).toBe('conversation')
    expect(result.instructions).toContain('你的能力与边界')
    expect(result.agentKey).toBe('sub:待办统计')
    expect(result.name).toBe('子助手：待办统计')
    // 关键：查目录会把 `sub:待办统计` 判成 3303
    expect(resolveAgentKey).not.toHaveBeenCalled()
  })

  it('子会话没快照（早于落快照的子 run）：回 unrecorded 空文本，不报 3303、不冒充父 agent', async () => {
    const { service, resolveAgentKey, instructions } = createService({
      entity: conversation({ id: 'sub-2', kind: 'subagent', agentKey: 'sub:旧助手', title: '' }),
      snapshot: null,
    })

    const result = await asUser(() => service.instructions({ conversationId: 'sub-2' }))

    expect(result.source).toBe('unrecorded')
    expect(result.instructions).toBe('')
    // 标题为空时回落 `sub:` 的后半段，而不是 `sub:旧助手` 整串
    expect(result.name).toBe('旧助手')
    expect(resolveAgentKey).not.toHaveBeenCalled()
    expect(instructions).not.toHaveBeenCalled()
  })

  it('主会话没快照：仍按所选 agent 回静态定义（行为不变）', async () => {
    const { service, resolveAgentKey } = createService({
      entity: conversation({ id: 'conv-1', kind: 'root', agentKey: 'assistant' }),
      snapshot: null,
    })

    const result = await asUser(() => service.instructions({ conversationId: 'conv-1' }))

    expect(result.source).toBe('definition')
    expect(resolveAgentKey).toHaveBeenCalledWith('assistant')
  })
})
