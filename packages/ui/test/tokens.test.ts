// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * 设计系统守卫：把「token 体系的硬约定」变成可执行断言。
 *
 * **刻意不维护任何手工 token 清单** —— 断言全部建立在 `globals.css` 自身的自洽性上：
 * 一份手抄的 token 名字数组本身就是新的漂移源（CSS 改了清单没改，守卫反而变成假绿）。
 *
 * 守什么（四类静默事故）：
 * ① 新增 token 只写了浅色忘了深色（深色下取值落空）；
 * ② 定义了 token 却忘了在 `@theme inline` 里映射（类名 `bg-xxx` 根本不存在）；
 * ③ 字体变量改名后回退链没跟着改（字体静默回落到系统字体）；
 * ④ 根层专属 token 被误删。
 *
 * 反向验证方式：删掉 `.dark` 里任一 token、摘掉 `@theme` 里任一映射、改字体变量名，
 * 本文件必须红灯。
 *
 * 注：ui 包默认是 jsdom 环境，而 `import.meta.url` 在 jsdom 下不是 `file://`，
 * `fileURLToPath` 会抛 `The URL must be of scheme file` —— 故标 node 环境。
 */
const css = readFileSync(fileURLToPath(new URL('../src/globals.css', import.meta.url)), 'utf8')

/** 取出某个顶层选择器块的内容（块内无嵌套大括号，故非贪婪匹配到行首右括号即可） */
function blockOf(selector: string): string {
  const pattern = new RegExp(
    `(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\n\\}`,
  )
  const matched = css.match(pattern)
  if (!matched?.[1]) throw new Error(`globals.css 中找不到选择器块「${selector}」`)
  return matched[1]
}

/** 提取块内声明的 CSS 变量名（保留 -- 前缀；`var(--x)` 引用不算声明） */
function declaredVars(block: string): Set<string> {
  return new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string))
}

/** 提取块内声明的 CSS 变量原始值（用于分辨「字面量」与「var() 引用」） */
function declaredRaw(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [
      m[1] as string,
      (m[2] as string).trim(),
    ]),
  )
}

/** 只应在浅色根定义一次、深色无需覆盖的 token */
const ROOT_ONLY_TOKENS = ['--radius', '--font-display'] as const

describe('设计系统 token 体系（globals.css 自洽性）', () => {
  const rootBlock = blockOf(':root')
  const light = declaredVars(rootBlock)
  const dark = declaredVars(blockOf('.dark'))
  const themeBlock = blockOf('@theme inline')
  const theme = declaredVars(themeBlock)

  it('浅色与深色的 token 键集合完全一致（明暗对称，除根层专属）', () => {
    const lightOnly = [...light]
      .filter((name) => !ROOT_ONLY_TOKENS.includes(name as (typeof ROOT_ONLY_TOKENS)[number]))
      .sort()
    expect(lightOnly).toEqual([...dark].sort())
  })

  it('@theme 的每个颜色映射都自洽（--color-X: var(--X)）且来源有明暗两套定义', () => {
    const mappings = [
      ...themeBlock.matchAll(/--color-([a-z0-9-]+)\s*:\s*var\((--[a-z0-9-]+)\)/g),
    ].map((match) => ({ token: `--${match[1]}`, source: match[2] as string }))

    // ① 键值同名（`--color-primary: var(--primary)`）—— 指向别的变量会让工具类取值落空
    expect(
      mappings.filter((m) => m.token !== m.source).map((m) => `${m.token} → ${m.source}`),
    ).toEqual([])

    // ② 来源变量在浅色与深色都有定义
    expect(
      mappings.filter((m) => !light.has(m.source) || !dark.has(m.source)).map((m) => m.source),
    ).toEqual([])
  })

  it('每个颜色 token 都在 @theme 里有映射（否则 token 有了、类名不存在）', () => {
    // 反向：:root 里以颜色语义命名、且不在 @theme 中的变量，就是漏映射的
    const unmapped = [...light]
      .filter((name) => !ROOT_ONLY_TOKENS.includes(name as (typeof ROOT_ONLY_TOKENS)[number]))
      .filter((name) => !name.startsWith('--md-hl-')) // markdown 高亮由 CSS 规则直接消费，不走工具类
      .filter((name) => name !== '--font-display')
      .filter((name) => !theme.has(`--color-${name.slice(2)}`))
    expect(unmapped).toEqual([])
  })

  it('根层专属 token 已定义', () => {
    expect(ROOT_ONLY_TOKENS.filter((token) => !light.has(token))).toEqual([])
  })

  it('字体回退链引用 app 注入的 next/font 变量，展示字体经 --font-display 派生', () => {
    // 这三个变量名是产品决策（Geist / Geist Mono / Space Grotesk），由 app 的 layout 用 next/font 注入；
    // 一致性由 check:ui 第 ⑤ 条与 apps/*/layout.tsx 的字面量对照（next/font 要求字面量，无法共享常量）
    expect(themeBlock).toMatch(/--font-sans:\s*var\(--font-geist\)/)
    expect(themeBlock).toMatch(/--font-mono:\s*var\(--font-geist-mono\)/)
    expect(rootBlock).toMatch(/--font-display:\s*var\(--font-space-grotesk\)/)
    expect(themeBlock).toContain('--font-heading: var(--font-display')
  })

  it('侧边栏与图表首色由主 token 派生（改主色能全局联动，不许改回手抄字面量）', () => {
    const derived = [
      'sidebar',
      'sidebar-foreground',
      'sidebar-primary',
      'sidebar-primary-foreground',
      'sidebar-accent',
      'sidebar-accent-foreground',
      'sidebar-border',
      'sidebar-ring',
      'chart-1',
    ]
    for (const [selector, block] of [
      [':root', rootBlock],
      ['.dark', blockOf('.dark')],
    ] as const) {
      const raw = declaredRaw(block)
      // 允许 var() 与基于 var() 的 color-mix 表达式（如品牌色淡底），只拦真正的手抄字面量
      const literal = derived.filter((name) => !raw.get(name)?.includes('var('))
      expect(literal, `${selector} 里这些 token 抄了字面量（改主色不会联动）`).toEqual([])
    }
    // 关键目标关系（浅色）：这三条错了，换品牌色就不会全局生效
    const rootRaw = declaredRaw(rootBlock)
    expect(rootRaw.get('sidebar-primary')).toBe('var(--brand)')
    expect(rootRaw.get('sidebar-ring')).toBe('var(--ring)')
    expect(rootRaw.get('chart-1')).toBe('var(--brand)')
  })
})
