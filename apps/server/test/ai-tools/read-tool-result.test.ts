import { describe, expect, it } from 'vitest'
import { ReadToolResultTool } from '../../src/modules/ai/tools/read-tool-result.tool.js'
import { makePageHandle } from '../../src/modules/ai/tools/paginate.js'
import { TOOL_KEYS } from '../../src/modules/ai/tools/tool-keys.js'
import { ToolDeniedError } from '../../src/modules/ai/tools/tools.types.js'
import { buildToolSpec } from '../../src/modules/ai/tools/tool.class.js'
import { buildToolStackDeps, makeToolContext } from '../helpers/ai-tool-stack.js'

/**
 * `read-tool-result`（取页）的单测：分页的回取通道。
 *
 * 覆盖三条防护：**越权**（别人的句柄）、**取不到**（内存与时间线都没有）、**滥用**（每轮取页上限）。
 */
const envelope = {
  conversationId: 'conv-1',
  parentRunId: 'run-1',
  triggeredBy: 'user-1',
  isAdmin: false,
  depth: 0,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  model: {},
  childToolbox: new Map(),
  skills: [],
}

/** 与信封同会话的调用方（越权判定就是拿它与句柄里的会话比） */
const caller = {
  conversationId: 'conv-1',
  runId: 'run-1',
  userId: 'user-1',
  isAdmin: false,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  depth: 0,
}

const build = (timelineOutput: string | null = null) => {
  const deps = buildToolStackDeps({ timelines: { findToolOutput: async () => timelineOutput } })
  const spec = buildToolSpec(new ReadToolResultTool(deps.results, deps.counter, deps.caps))
  return { deps, spec }
}

describe('read-tool-result（取下一页）', () => {
  it('同轮内存命中：逐页取回，拼起来**逐字节等于原文**（不重不漏）', async () => {
    const { deps, spec } = build()
    // 把单页压到 64 字节，保证这篇原文**在每轮取页上限（env 默认 5 次）之内**有多页：
    // 64 × 5 = 320 字节，正文取 200 字符（含 JSON 外壳约 215 字节 → 4 页）
    deps.source.set(TOOL_KEYS.readToolResult, { limits: { pageBytes: 64 } })
    const full = JSON.stringify({ text: 'x'.repeat(200) })
    deps.results.remember('conv-1', 'call-1', full)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope, caller })
    const handle = makePageHandle('conv-1', 'call-1')

    let joined = ''
    let page = 1
    for (;;) {
      const result = (await spec.exec({ handle, page }, ctx as never)) as {
        page: { page: number; totalPages: number; hasMore: boolean }
        content: string
      }
      expect(result.page.page).toBe(page)
      joined += result.content
      if (!result.page.hasMore) break
      page += 1
      expect(page).toBeLessThan(100) // 防死循环
    }
    expect(joined).toBe(full)
    expect(page).toBeGreaterThan(1)
  })

  it('跨轮兜底：内存没有时从时间线取（原文永久保留）', async () => {
    const full = JSON.stringify({ text: 'y'.repeat(300) })
    const { deps, spec } = build(full)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope, caller })
    const result = (await spec.exec(
      { handle: makePageHandle('conv-1', 'call-x'), page: 1 },
      ctx as never,
    )) as { content: string; page: { totalBytes: number } }
    expect(result.page.totalBytes).toBe(Buffer.byteLength(full, 'utf8'))
    expect(result.content.length).toBeGreaterThan(0)
  })

  it('越权：句柄属于别的会话 → forbidden（不能拿别人的句柄读别人的结果）', async () => {
    const { deps, spec } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope, caller })
    await expect(
      spec.exec({ handle: makePageHandle('conv-other', 'call-1'), page: 1 }, ctx as never),
    ).rejects.toMatchObject({ reason: 'forbidden' })
  })

  it('句柄格式不对 → invalid-input', async () => {
    const { deps, spec } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope, caller })
    await expect(spec.exec({ handle: 'bogus', page: 1 }, ctx as never)).rejects.toBeInstanceOf(
      ToolDeniedError,
    )
  })

  it('取不到（内存与时间线都没有）→ precheck-failed，并给"重跑一次"的建议', async () => {
    const { deps, spec } = build(null)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope, caller })
    await expect(
      spec.exec({ handle: makePageHandle('conv-1', 'missing'), page: 1 }, ctx as never),
    ).rejects.toMatchObject({ reason: 'precheck-failed' })
  })

  it('滥用防护：每轮取页次数超上限 → rate-limited', async () => {
    const { deps, spec } = build()
    const full = JSON.stringify({ text: 'z'.repeat(400) })
    deps.results.remember('conv-1', 'call-1', full)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope, caller })
    const handle = makePageHandle('conv-1', 'call-1')
    // 默认上限 5 次（`TEST_TOOL_ENV_CAPS.maxPagesPerTurnMax`）
    for (let index = 0; index < 5; index += 1) {
      await spec.exec({ handle, page: 1 }, ctx as never)
    }
    await expect(spec.exec({ handle, page: 1 }, ctx as never)).rejects.toMatchObject({
      reason: 'rate-limited',
    })
  })

  it('它是常驻的内建工具（key 固定、不分页自己、子 agent 也能用）', () => {
    const { spec } = build()
    expect(spec.key).toBe(TOOL_KEYS.readToolResult)
    expect(spec.paginate).toBeUndefined()
    expect(spec.child ?? 'allow').toBe('allow')
  })
})
