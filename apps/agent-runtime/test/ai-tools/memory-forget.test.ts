import { describe, expect, it, vi } from 'vitest'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import { MemoryTools } from '../../src/modules/ai/memory/memory.tools.js'
import { buildToolStackDeps, makeToolContext, specByKey } from '../helpers/ai-tool-stack.js'

/** `memory-forget`：按 id / key 删自己的记忆；找不到给可纠正结论 */
const build = (service: unknown) => {
  const deps = buildToolStackDeps()
  const tools = new MemoryTools(service as never)
  const spec = specByKey(tools, TOOL_KEYS.memoryForget)
  return { deps, spec, tools }
}

describe('memory-forget（忘掉一件事）', () => {
  it('按 id 删除成功', async () => {
    const forgetFromTool = vi.fn(async () => true)
    const { deps, spec } = build({ forgetFromTool })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings })

    const result = await spec.exec({ id: 'mem-1' }, ctx as never)

    expect(result).toEqual({ forgotten: true })
    expect(forgetFromTool).toHaveBeenCalledWith('user-test', 'assistant', { id: 'mem-1' })
  })

  it('找不到时给可纠正结论（可能已经删了）', async () => {
    const { deps, spec } = build({ forgetFromTool: async () => false })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings })

    await expect(spec.exec({ key: 'reply-style' }, ctx as never)).rejects.toThrow(/没找到这条记忆/)
  })

  it('前置检查：id 与 key 二选一', () => {
    const { tools } = build({})
    expect(tools.checkForget({})).toContain('id 或 key')
    expect(tools.checkForget({ id: 'mem-1' })).toBeNull()
    expect(tools.checkForget({ key: 'reply-style' })).toBeNull()
  })
})
