import { describe, expect, it, vi } from 'vitest'
import type { ConversationEntity } from '@repo/db'
import type { AppLogger } from '@repo/kits'
import type { AgentConversationListDto, AgentConversationModel } from '@repo/shared'
import { requestContext } from '../src/common/index.js'
import { AiConversationRepository } from '../src/modules/ai-admin/conversation/conversation.repository.js'
import { AiAdminConversationService } from '../src/modules/ai-admin/conversation/conversation.service.js'
import { ConversationNotFoundError } from '../src/modules/ai-admin/conversation/errors.js'
import { AiRunQueryRepository } from '../src/modules/ai-admin/conversation/run-query.repository.js'
import { AiSkillQueryRepository } from '../src/modules/ai-admin/conversation/skill-query.repository.js'
import { AiTimelineQueryRepository } from '../src/modules/ai-admin/conversation/timeline-query.repository.js'
import type { AiModelService } from '../src/modules/ai-model/index.js'
import type { AiUsageService } from '../src/modules/ai-usage/index.js'

/** 构造一个只暴露被测方法的服务；其余仓储给空壳（本测试只走会话列表 / 归属校验） */
const createService = (
  overrides: {
    list?: (
      userId: string,
      input: AgentConversationListDto,
    ) => Promise<{
      items: AgentConversationModel[]
      total: number
      page: number
      size: number
    }>
    findEntity?: (id: string) => Promise<ConversationEntity | null>
  } = {},
) => {
  const list = vi.fn(
    overrides.list ??
      (async (_userId: string, input: AgentConversationListDto) => ({
        items: [],
        total: 0,
        page: input.page,
        size: input.size,
      })),
  )
  const findEntity = vi.fn(overrides.findEntity ?? (async (_id: string) => null))
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }

  const service = new AiAdminConversationService(
    { list, findEntity } as unknown as AiConversationRepository,
    {} as AiRunQueryRepository,
    {} as AiTimelineQueryRepository,
    {} as AiSkillQueryRepository,
    {} as AiUsageService,
    {} as AiModelService,
    logger as unknown as AppLogger,
  )
  return { service, list, findEntity }
}

const conversationModel = (id: string): AgentConversationModel => ({
  id,
  agentKey: 'assistant',
  title: '会话',
  status: 'active',
  fileAccess: 'workspace-write',
  turnCount: 0,
  totalTokens: 0,
  running: false,
  lastActiveAt: new Date('2026-11-14T00:00:00.000Z'),
  createdAt: new Date('2026-11-14T00:00:00.000Z'),
  updatedAt: new Date('2026-11-14T00:00:00.000Z'),
})

const context = (data: { userId: string | null; adminId: string | null }) => ({
  requestId: 'test-request',
  userId: data.userId,
  adminId: data.adminId,
})

const input: AgentConversationListDto = { page: 1, size: 20, includeDeleted: false }

describe('AiAdminConversationService（会话列表归属）', () => {
  it('前台用户：列表归属取 requestContext.userId，且原样传给仓储', async () => {
    const { service, list } = createService({
      list: async () => ({
        items: [conversationModel('conv-user')],
        total: 1,
        page: 1,
        size: 20,
      }),
    })

    const result = await requestContext.run(context({ userId: 'user-1', adminId: null }), () =>
      service.list(input),
    )

    expect(list).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith('user-1', input)
    expect(result.items.map((item) => item.id)).toEqual(['conv-user'])
  })

  it('管理员身份：没有 userId 时回落到 adminId（管理员在会话页的归属）', async () => {
    const { service, list } = createService()

    await requestContext.run(context({ userId: null, adminId: 'admin-1' }), () =>
      service.list(input),
    )

    expect(list).toHaveBeenCalledWith('admin-1', input)
  })

  it('详情按所属身份校验：不是自己的会话返回 3304（不区分不存在与越权）', async () => {
    const { service } = createService({
      findEntity: async (id) => ({ id, userId: 'someone-else' }) as unknown as ConversationEntity,
    })

    await expect(
      requestContext.run(context({ userId: 'user-1', adminId: null }), () =>
        service.detail({ conversationId: 'conv-1' }),
      ),
    ).rejects.toBeInstanceOf(ConversationNotFoundError)
  })

  it('没有身份上下文时直接报错（守卫放行却没写身份 = 编程错误）', async () => {
    const { service } = createService()

    expect(() =>
      requestContext.run(context({ userId: null, adminId: null }), () => service.list(input)),
    ).toThrow('Authenticated request context is unavailable')
  })
})
