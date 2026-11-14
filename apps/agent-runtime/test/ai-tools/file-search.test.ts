import { describe, expect, it } from 'vitest'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import { specByKey } from '../helpers/ai-tool-stack.js'
import { buildFileTools } from '../helpers/file-tools.js'

describe('file-search（文件管理）', () => {
  it('声明了 key / 说明 / 参数，且合法入参能过 schema', () => {
    const spec = specByKey(buildFileTools(), TOOL_KEYS.fileSearch)
    expect(spec.key).toBe('file-search')
    expect(spec.description.length).toBeGreaterThan(0)
    expect(spec.params.safeParse({ keywords: '计费 规则' }).success).toBe(true)
  })
})
