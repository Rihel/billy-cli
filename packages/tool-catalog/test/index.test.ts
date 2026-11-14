import { describe, expect, it } from 'vitest'
import { TOOL_DEFINITIONS, getToolDefinition, toToolManifest } from '../src/index.js'

describe('@repo/tool-catalog', () => {
  it('定义清单是唯一来源，包含 bash / web-fetch', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.key)).toEqual(
      expect.arrayContaining([
        'bash',
        'web-fetch',
        'web-search',
        'memory-save',
        'skill-list',
        'file-submit',
        'read-tool-result',
      ]),
    )
    expect(getToolDefinition('bash')?.title).toBe('执行 bash 命令')
    expect(getToolDefinition('web-search')?.executor).toBe('worker')
  })

  it('manifest 参数带必填 reason，且来自同一份 Zod 定义', () => {
    const manifest = toToolManifest(getToolDefinition('bash')!)
    const params = manifest.params as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(params.properties.command).toBeTruthy()
    expect(params.properties.reason).toBeTruthy()
    expect(params.required).toContain('reason')
  })
})
