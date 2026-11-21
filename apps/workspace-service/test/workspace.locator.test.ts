import { describe, expect, it, vi } from 'vitest'
import { WorkspaceLocator } from '../src/capabilities/workspace.locator.js'

/**
 * 会话 → 工作区解析（能力侧）。
 *
 * 覆盖三层语义：本行有值直接用、本行空但有根会话就回落根会话、都没有返回 null；
 * 同时盯住缓存口径 —— 只缓存命中结果，null 不入缓存（否则阴性结果会被缓存 30s）。
 */

const make = (
  rows: Record<
    string,
    { id: string; workspaceId: string | null; rootConversationId: string | null }
  >,
) => {
  const findOne = vi.fn(async ({ where }: { where: { id: string } }) => {
    const row = rows[where.id]
    if (!row) return null
    return { id: row.id, workspaceId: row.workspaceId, rootConversationId: row.rootConversationId }
  })
  const db = { getRepository: () => ({ findOne }) }
  return { locator: new WorkspaceLocator(db as never), findOne }
}

describe('WorkspaceLocator.workspaceIdOf', () => {
  it('本行有 workspaceId：直接返回，命中后走缓存不再打库', async () => {
    const { locator, findOne } = make({
      c_root: { id: 'c_root', workspaceId: 'ws_root', rootConversationId: null },
    })

    expect(await locator.workspaceIdOf('c_root')).toBe('ws_root')
    expect(await locator.workspaceIdOf('c_root')).toBe('ws_root')
    expect(findOne).toHaveBeenCalledTimes(1)
  })

  it('本行为空且有 rootConversationId：回落根会话的值，并把命中写进缓存', async () => {
    const { locator, findOne } = make({
      c_child: { id: 'c_child', workspaceId: null, rootConversationId: 'c_root' },
      c_root: { id: 'c_root', workspaceId: 'ws_root', rootConversationId: null },
    })

    expect(await locator.workspaceIdOf('c_child')).toBe('ws_root')
    // 两次查询：本行一次、根会话一次；第二次调用整体走缓存
    expect(findOne).toHaveBeenCalledTimes(2)
    expect(await locator.workspaceIdOf('c_child')).toBe('ws_root')
    expect(findOne).toHaveBeenCalledTimes(2)
  })

  it('本行与根会话都没有工作区：返回 null，且不缓存 null（下次仍会重新查）', async () => {
    const { locator, findOne } = make({
      c_child: { id: 'c_child', workspaceId: null, rootConversationId: 'c_root' },
      c_root: { id: 'c_root', workspaceId: null, rootConversationId: null },
    })

    expect(await locator.workspaceIdOf('c_child')).toBeNull()
    expect(await locator.workspaceIdOf('c_child')).toBeNull()
    // 没有缓存阴性结果：每轮都是本行 + 根会话两次查询
    expect(findOne).toHaveBeenCalledTimes(4)
  })

  it('会话不存在：返回 null，不缓存', async () => {
    const { locator, findOne } = make({})

    expect(await locator.workspaceIdOf('c_missing')).toBeNull()
    expect(await locator.workspaceIdOf('c_missing')).toBeNull()
    expect(findOne).toHaveBeenCalledTimes(2)
  })
})
