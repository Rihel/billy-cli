import { describe, expect, it, vi } from 'vitest'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import { MemoryTools } from '../../src/modules/ai/memory/memory.tools.js'
import { buildToolStackDeps, makeToolContext, specByKey } from '../helpers/ai-tool-stack.js'

/**
 * `memory-save` 的单测：只钉它的语义（身份从哪来、成功返回什么、失败给什么结论），
 * 存储与上限的细节在 `ai-memory.test.ts`。
 */
const build = (service: unknown) => {
  const deps = buildToolStackDeps()
  const spec = specByKey(new MemoryTools(service as never), TOOL_KEYS.memorySave)
  return { deps, spec }
}

describe('memory-save（记住一件事）', () => {
  it('用调用者身份写入，返回新 id 与 key', async () => {
    const saveFromTool = vi.fn(async () => ({
      ok: true as const,
      memory: { id: 'mem-1', memKey: 'reply-style' },
    }))
    const { deps, spec } = build({ saveFromTool })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings })

    const result = await spec.exec({ content: '偏好简短回答', key: 'reply-style' }, ctx as never)

    expect(result).toEqual({ saved: true, id: 'mem-1', key: 'reply-style' })
    expect(saveFromTool).toHaveBeenCalledWith(
      'user-test',
      'assistant',
      expect.objectContaining({ content: '偏好简短回答', key: 'reply-style' }),
    )
  })

  it('没有用户身份时拒绝（系统 / 定时任务不能写记忆）', async () => {
    const { deps, spec } = build({ saveFromTool: vi.fn() })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, caller: null })

    await expect(spec.exec({ content: '偏好简短回答' }, ctx as never)).rejects.toThrow(
      /没有用户身份/,
    )
  })

  it('存储层拒绝（超限）时把可纠正的理由给模型', async () => {
    const { deps, spec } = build({
      saveFromTool: async () => ({ ok: false as const, reason: '每个用户最多 200 条记忆' }),
    })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings })

    await expect(spec.exec({ content: '偏好简短回答' }, ctx as never)).rejects.toThrow(
      /最多 200 条/,
    )
  })
})
