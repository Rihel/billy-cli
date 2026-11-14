import { describe, expect, it, vi } from 'vitest'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import { MemoryTools } from '../../src/modules/ai/memory/memory.tools.js'
import { buildToolStackDeps, makeToolContext, specByKey } from '../helpers/ai-tool-stack.js'

/** `memory-search`：按关键词查自己的记忆，出参只带展示需要的字段 */
const build = (service: unknown) => {
  const deps = buildToolStackDeps()
  const spec = specByKey(new MemoryTools(service as never), TOOL_KEYS.memorySearch)
  return { deps, spec }
}

describe('memory-search（查长期记忆）', () => {
  it('按调用者身份检索并裁成展示字段', async () => {
    const searchFromTool = vi.fn(async () => [
      {
        id: 'mem-1',
        kind: 'preference',
        content: '偏好简短回答',
        pinned: true,
        updatedAt: new Date('2026-11-14T00:00:00Z'),
        userId: 'user-test',
        secret: '不该出现在出参里',
      },
    ])
    const { deps, spec } = build({ searchFromTool })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings })

    const result = (await spec.exec({ query: '偏好', limit: 10 }, ctx as never)) as {
      total: number
      items: Array<Record<string, unknown>>
    }

    expect(searchFromTool).toHaveBeenCalledWith('user-test', 'assistant', '偏好', 10)
    expect(result.total).toBe(1)
    expect(result.items[0]).not.toHaveProperty('secret')
    expect(result.items[0]?.content).toBe('偏好简短回答')
  })

  it('没有用户身份时拒绝', async () => {
    const { deps, spec } = build({ searchFromTool: vi.fn() })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, caller: null })

    await expect(spec.exec({ query: '偏好' }, ctx as never)).rejects.toThrow(/没有用户身份/)
  })
})
