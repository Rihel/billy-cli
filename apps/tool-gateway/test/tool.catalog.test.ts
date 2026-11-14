import { describe, expect, it } from 'vitest'
import { TOOL_CONTRACT_VERSION, type ToolCaller } from '@repo/contracts'
import { ToolCatalogService } from '../src/catalog/tool.catalog.js'
import type { ToolConfigService } from '../src/config/tool.config.service.js'

const caller = (isAdmin = false): ToolCaller => ({
  conversationId: 'c-1',
  runId: 'r-1',
  userId: 'u-1',
  isAdmin,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  depth: 0,
})

const toolConfig = {
  effective: async () => ({
    enabled: true,
    scope: null,
    allowedAgents: null,
    config: {},
    limits: {},
    secrets: {},
    version: 'test',
  }),
} as unknown as ToolConfigService

describe('ToolCatalogService', () => {
  it('返回 bash manifest，params 是 JSON Schema', async () => {
    const tools = await new ToolCatalogService(toolConfig).list({
      caller: caller(),
      agentKey: 'assistant',
      depth: 0,
    })
    expect(tools.length).toBeGreaterThan(20)
    const bash = tools.find((tool) => tool.key === 'bash')!
    expect(bash.key).toBe('bash')
    expect(bash.executor).toBe('worker')
    expect(bash.version).toBe(TOOL_CONTRACT_VERSION)
    expect(bash.params).toMatchObject({ type: 'object' })
  })

  it('admin 调用也拿得到 all 作用域工具', async () => {
    const tools = await new ToolCatalogService(toolConfig).list({
      caller: caller(true),
      agentKey: 'assistant',
      depth: 0,
    })
    expect(tools.map((tool) => tool.key)).toEqual(expect.arrayContaining(['bash', 'web-fetch']))
  })
})
