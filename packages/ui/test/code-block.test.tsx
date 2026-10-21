import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CodeBlock } from '../src/components/ai-elements/code-block.tsx'

/**
 * `CodeBlock` 的空值兜底。
 *
 * `code` 在类型上是 `string`，但最常见的调用方写法 `JSON.stringify(value)` 在 value 为
 * `undefined` 时**运行时返回 undefined**（lib 类型却声明为 string，编译器拦不住）。
 * 共享展示组件若不自己兜住，一个空入参就会在 `createRawTokens` 的 `code.split` 处抛
 * TypeError，把整棵会话树打崩（2026-10-18「仙逆剧本」会话白屏）。
 */
describe('CodeBlock 空值兜底', () => {
  it('code 为 undefined 时按空串渲染，不抛错', () => {
    expect(() =>
      renderToStaticMarkup(<CodeBlock code={undefined as unknown as string} language="json" />),
    ).not.toThrow()
  })

  it('正常字符串仍然按原文渲染（兜底不改变正常路径）', () => {
    const html = renderToStaticMarkup(<CodeBlock code={'{\n  "a": 1\n}'} language="json" />)

    expect(html).toContain('&quot;a&quot;')
  })
})
