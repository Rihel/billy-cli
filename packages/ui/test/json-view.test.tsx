import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  countJsonEntries,
  formatJsonValue,
  isJsonContainer,
  jsonValueKind,
  JsonView,
  parseJsonText,
  summarizeJsonValue,
} from '../src/components/json-view.tsx'

/**
 * JSON 查看器：纯函数决定"怎么判断、怎么摘要、要不要退回原文"，组件只负责画。
 * 这里两侧都测 —— 摘要说错了（比如把 3 个字段说成 3 项）比画得丑更糟。
 */
afterEach(() => cleanup())

describe('parseJsonText', () => {
  it('合法 JSON 返回解析结果', () => {
    const result = parseJsonText('{"a":1}')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ a: 1 })
  })

  it('非法 JSON 返回原因，不抛错', () => {
    const result = parseJsonText('{oops}')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })
})

describe('类型判断与摘要', () => {
  it('类型标签覆盖 JSON 的六种形态', () => {
    expect(jsonValueKind('x')).toBe('string')
    expect(jsonValueKind(1)).toBe('number')
    expect(jsonValueKind(false)).toBe('boolean')
    expect(jsonValueKind(null)).toBe('null')
    expect(jsonValueKind([])).toBe('array')
    expect(jsonValueKind({})).toBe('object')
    // undefined / 函数不是合法 JSON，兜底按 null 处理
    expect(jsonValueKind(undefined)).toBe('null')
  })

  it('只有对象和数组算容器', () => {
    expect(isJsonContainer({})).toBe(true)
    expect(isJsonContainer([])).toBe(true)
    expect(isJsonContainer('x')).toBe(false)
    expect(isJsonContainer(null)).toBe(false)
  })

  it('摘要区分字段数与项数，长字符串截断', () => {
    expect(summarizeJsonValue({ a: 1, b: 2 })).toBe('{2 个字段}')
    expect(summarizeJsonValue([1, 2, 3])).toBe('[3 项]')
    expect(summarizeJsonValue(null)).toBe('null')
    const long = 'x'.repeat(200)
    expect(summarizeJsonValue(long).endsWith('…')).toBe(true)
    expect(summarizeJsonValue(long).length).toBeLessThan(long.length)
  })

  it('条目计数含嵌套，到上限就停', () => {
    expect(countJsonEntries({ a: 1, b: { c: 2 } })).toBe(3)
    // 上限 2：数到第 2 条就返回，不再往下走（避免为"是否超限"数全量）
    expect(countJsonEntries([1, 2, 3], 2)).toBe(2)
  })

  it('格式化：正常值缩进，循环引用退回字符串', () => {
    expect(formatJsonValue({ a: 1 })).toContain('\n')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => formatJsonValue(cyclic)).not.toThrow()
  })
})

describe('JsonView 渲染', () => {
  it('默认按树显示，嵌套两层默认展开', () => {
    const { container } = render(<JsonView text={'{"name":"billy","meta":{"version":2,"stable":true}}'} />)
    expect(container.querySelector('[data-json-view="tree"]')).not.toBeNull()
    expect(container.textContent ?? '').toContain('name')
    // 第二层默认展开
    expect(container.textContent ?? '').toContain('version')
  })

  it('切到「原文」显示格式化后的 JSON', () => {
    const { container, getByText } = render(<JsonView text={'{"a":1}'} />)
    fireEvent.click(getByText('原文'))
    expect(container.querySelector('[data-json-view="raw"]')).not.toBeNull()
    expect(container.querySelector('pre')?.textContent ?? '').toContain('"a": 1')
  })

  it('解析失败时给出原因并保留原文', () => {
    const { container } = render(<JsonView text={'{"a": '} />)
    expect(container.querySelector('[data-json-view="error"]')).not.toBeNull()
    expect(container.textContent ?? '').toContain('解析不了')
    expect(container.querySelector('pre')?.textContent ?? '').toContain('{"a":')
  })

  it('内容过大时不做树，直接按原文显示并说明', () => {
    const huge = `[${Array.from({ length: 5000 }, (_, index) => index).join(',')}]`
    const { container } = render(<JsonView text={huge} />)
    expect(container.querySelector('[data-json-view="raw"]')).not.toBeNull()
    expect(container.textContent ?? '').toContain('内容过大')
  })

  it('收起全部后只剩根节点摘要', () => {
    const { container, getByText } = render(<JsonView text={'{"a":{"b":1}}'} />)
    fireEvent.click(getByText('收起全部'))
    const text = container.textContent ?? ''
    expect(text).toContain('{1 个字段}')
    expect(text).not.toContain('b:')
  })
})
