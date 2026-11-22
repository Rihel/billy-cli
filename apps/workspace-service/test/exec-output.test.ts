import { describe, expect, it } from 'vitest'
import {
  MAX_EXEC_OUTPUT,
  TRUNCATED_MARK,
  createOutputCollector,
  resolveMaxOutput,
} from '../src/workspace/exec-output.js'

describe('命令输出收集器', () => {
  it('未超限原样返回，不标截断', () => {
    const out = createOutputCollector(1024)
    out.push(Buffer.from('hello '))
    out.push(Buffer.from('world'))
    expect(out.text()).toBe('hello world')
    expect(out.truncated()).toBe(false)
  })

  it('超限即停止累积并打中文标记（按字节，且不会无限吃内存）', () => {
    const out = createOutputCollector(8)
    // 16 个 chunk，每个 64KB：只有前一个半 chunk 会被收下
    for (let index = 0; index < 16; index += 1) out.push(Buffer.alloc(64 * 1024, 0x61))
    const text = out.text()
    expect(out.truncated()).toBe(true)
    expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024 + 1024)
    expect(text.endsWith(TRUNCATED_MARK)).toBe(true)
  })

  it('多字节字符在边界上只可能留下多余字符，不会抛错', () => {
    const out = createOutputCollector(5)
    out.push(Buffer.from('中文中文', 'utf8'))
    expect(out.truncated()).toBe(true)
    // 按字节切到第 5 字节：'中' 完整，'文' 只剩前两个字节 → 末尾一个替换符
    expect(out.text().startsWith('中')).toBe(true)
  })

  it('上限只允许压小，且不小于 1KB', () => {
    expect(resolveMaxOutput(undefined)).toBe(MAX_EXEC_OUTPUT)
    expect(resolveMaxOutput(1024 * 1024)).toBe(MAX_EXEC_OUTPUT)
    expect(resolveMaxOutput(4096)).toBe(4096)
    expect(resolveMaxOutput(1)).toBe(1024)
  })
})
