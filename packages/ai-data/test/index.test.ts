import { describe, expect, it } from 'vitest'
import { MemoryRepository, MemoryService } from '../src/index.js'

describe('@repo/ai-data', () => {
  it('导出 memory 数据层，供 server 与 worker 共用', () => {
    expect(typeof MemoryService).toBe('function')
    expect(typeof MemoryRepository).toBe('function')
  })
})
