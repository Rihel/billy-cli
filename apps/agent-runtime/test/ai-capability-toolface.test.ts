import { describe, expect, it } from 'vitest'
import type { CapabilityInfo } from '@repo/contracts'
import { ALL_TOOLS } from '../src/modules/ai/tools/engine/tools.types.js'
import { addCapabilityTools } from '../src/modules/ai/tools/engine/external.tool.js'

/**
 * 能力目录 → 工具面的合并口径（主 agent 与子助手**共用**，2026-11-22 定）。
 *
 * 规则：除了委派类（子助手不能再造子 agent）与 `ask-user-questions`（子助手没人能回答），
 * 子助手的工具面必须与主 agent 一致 —— 包括本会话用 `tool-search` 搜到的 MCP / 外部工具。
 * 回归：旧实现只给 `source='code'`，外部能力在子助手那侧被静默丢掉。
 */

const cap = (key: string, source: 'code' | 'manual'): CapabilityInfo => ({
  key,
  name: key,
  service: source === 'code' ? 'common' : 'mcp-demo',
  source,
  tool: key,
  title: key,
  description: `${key} 的说明`,
  inputSchema: { type: 'object', properties: {} },
  risk: 'read',
  scope: 'all',
  available: true,
  tags: [],
})

const remote = { supports: () => true, invoke: async () => ({ ok: true }) } as never

describe('addCapabilityTools', () => {
  it('source=code 的内部能力不依赖发现记录，总是补进工具面', () => {
    const toolbox = new Map()
    addCapabilityTools({
      toolbox,
      capabilities: [cap('read-file', 'code')],
      declared: [ALL_TOOLS],
      discovered: [],
      remote,
    })
    expect([...toolbox.keys()]).toEqual(['read-file'])
  })

  it('外部/MCP 能力只补本会话搜到过的（与主 agent 同一口径）', () => {
    const toolbox = new Map()
    addCapabilityTools({
      toolbox,
      capabilities: [cap('mcp-calendar.create', 'manual'), cap('mcp-jira.search', 'manual')],
      declared: [ALL_TOOLS],
      discovered: ['mcp-jira.search'],
      remote,
    })
    expect([...toolbox.keys()]).toEqual(['mcp-jira.search'])
  })

  it('本地注册机已经有同名 key 时跳过（避免两份）', () => {
    const toolbox = new Map()
    addCapabilityTools({
      toolbox,
      capabilities: [cap('tool-search', 'code')],
      declared: [ALL_TOOLS],
      discovered: [],
      remote,
      skipKeys: new Set(['tool-search']),
    })
    expect(toolbox.size).toBe(0)
  })

  it('没有 ALL_TOOLS 时仍按声明清单收口（与主 agent 相同的选择器语义）', () => {
    const toolbox = new Map()
    addCapabilityTools({
      toolbox,
      capabilities: [cap('read-file', 'code'), cap('bash', 'code')],
      declared: ['read-file'],
      discovered: [],
      remote,
    })
    expect([...toolbox.keys()]).toEqual(['read-file'])
  })
})
