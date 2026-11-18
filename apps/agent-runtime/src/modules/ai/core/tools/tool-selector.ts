import { TOOL_CATEGORY_VALUES } from './tools.types.js'
import type { ToolCategoryValue } from './tools.types.js'

/**
 * **工具选择器**：agent 授权清单里，除了具体 key，还能按「类别」批量选。
 *
 * 结构化的对象，不用字符串语法 —— agent 是代码定义的，类型检查能在编译期挡住拼写错误，
 * 也省掉一层解析器（`docs/design/ai-agent-tool-engine.md` 的授权一节）。
 *
 * ```ts
 * tools: [
 *   TOOL_KEYS.planCreate,   // 具体 key（字符串，原来的写法）
 *   ALL_TOOLS,              // 全量（字符串 '*'，示例 agent 用）
 *   { category: 'core' },   // 某一类工具
 * ]
 * ```
 *
 * 口径：**具体 key 必须存在**——写错在装配期报错（注册机 `spec()` 会抛），不拖到运行期。
 */

/** 按类别批量选，或"全部外部工具" */
export type ToolPattern = { readonly category: ToolCategoryValue } | { readonly external: true }

/** 授权清单里的"全部外部工具"（能力目录里、本地没声明的那些） */
export const EXTERNAL_TOOLS = { external: true } as const

/** 是不是"全部外部工具"选择器 */
export const isExternalSelector = (selector: ToolSelector): boolean =>
  typeof selector === 'object' && 'external' in selector

/** 授权清单里的一项：具体 key（含 `'*'`）或批量选择器 */
export type ToolSelector = string | ToolPattern

/** 展开选择器时需要的最小信息（注册机从每个工具声明上取） */
export interface ToolSelectorEntry {
  key: string
  category: ToolCategoryValue
}

const isCategory = (value: string): value is ToolCategoryValue =>
  (TOOL_CATEGORY_VALUES as readonly string[]).includes(value)

/**
 * 校验一个选择器（运行时兜底）。
 *
 * 代码里写的时候 TS 已经挡了一层；这里防的是"从 JSON / 后台配置里读进来的"那一份——
 * 它不该因为写错一个类别就静默匹配不到，应该当场说清楚。
 */
const assertSelector = (selector: ToolSelector): void => {
  if (typeof selector === 'string') {
    if (!selector.trim()) throw new Error('工具选择器不能为空')
    if (/\s/.test(selector.trim())) throw new Error(`工具选择器不能包含空白：${selector}`)
    return
  }
  if ('external' in selector) {
    if (selector.external !== true) throw new Error('工具选择器 external 只能是 true')
    return
  }
  if (!('category' in selector)) {
    throw new Error('工具选择器必须带 category 或 external')
  }
  if (!isCategory(selector.category)) {
    throw new Error(
      `未知的工具类别：${String(selector.category)}（可用：${TOOL_CATEGORY_VALUES.join(' / ')}）`,
    )
  }
}

/**
 * 展开一组选择器，返回工具 key（去重、保持首次出现的顺序）。
 *
 * `entries` 是**当前注册机里所有工具**（静态 + 动态）。具体 key 原样返回，由调用方
 * （`ToolRegistry.spec()`）负责"不存在就报错"——装配期与运行期同一套判据。
 */
export const expandToolSelectors = (
  selectors: readonly ToolSelector[],
  entries: readonly ToolSelectorEntry[],
): string[] => {
  const keys: string[] = []
  const seen = new Set<string>()
  const push = (key: string): void => {
    if (seen.has(key)) return
    seen.add(key)
    keys.push(key)
  }

  for (const selector of selectors) {
    assertSelector(selector)
    if (typeof selector === 'string') {
      const key = selector.trim()
      if (key === '*') {
        for (const entry of entries) push(entry.key)
      } else {
        push(key)
      }
      continue
    }
    if ('external' in selector) continue // 外部工具不在本地注册机里，由装配层从目录补
    for (const entry of entries) {
      if (entry.category === selector.category) push(entry.key)
    }
  }

  return keys
}
