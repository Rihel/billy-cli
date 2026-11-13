import { TOOL_CATEGORY_VALUES } from './tools.types.js'
import type { ToolCategoryValue } from './tools.types.js'

/**
 * **工具选择器**：agent 授权清单里，除了具体 key，还能按「类别」或「连接器」批量选。
 *
 * 结构化的对象，不用字符串语法 —— agent 是代码定义的，类型检查能在编译期挡住拼写错误，
 * 也省掉一层解析器（`docs/design/ai-agent-tool-engine.md` 的授权一节）。
 *
 * ```ts
 * tools: [
 *   TOOL_KEYS.planCreate,                    // 具体 key（字符串，原来的写法）
 *   ALL_TOOLS,                               // 全量（字符串 '*'，示例 agent 用）
 *   { category: 'connector' },               // 某一类工具
 *   { connector: 'prod-pg' },                // 某个连接器产出的全部工具
 *   { connector: 'prod-pg', tool: 'query' }, // 某个连接器产出的一个工具（工具名用接入方原名）
 * ]
 * ```
 *
 * 口径：
 * - **具体 key 必须存在**：写错在装配期报错（注册机 `spec()` 会抛），不拖到运行期；
 * - **连接器选择器允许零命中**：连接器是运行期同步进来的，启动时可能还没同步；
 * - **只做正向展开，不做 key 反解**：连接器 key 与工具名都含 `-`，反解必然歧义
 *   （见 `connectors/connector.keys.ts`），精确匹配用 spec 上的 `connector.toolName`。
 */

/** 按类别 / 连接器批量选 */
export type ToolPattern =
  | { readonly category: ToolCategoryValue }
  | { readonly connector: string; readonly tool?: string }

/** 授权清单里的一项：具体 key（含 `'*'`）或批量选择器 */
export type ToolSelector = string | ToolPattern

/** 展开选择器时需要的最小信息（注册机从每个工具声明上取） */
export interface ToolSelectorEntry {
  key: string
  category: ToolCategoryValue
  /** 连接器产出的工具才有：实例 key */
  connectorKey?: string
  /** 连接器产出的工具才有：接入方的工具原名（不是归一化后的 key 尾巴） */
  connectorToolName?: string
}

/** 连接器选择器里的实例 key 口径（与 `isValidConnectorKey` 一致） */
const CONNECTOR_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** 实例 key 的最大长度（与 `ai_connectors.key` 的 varchar(32) 一致） */
const CONNECTOR_KEY_MAX = 32

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
  const hasCategory = 'category' in selector
  const hasConnector = 'connector' in selector
  if (hasCategory === hasConnector) {
    throw new Error('工具选择器必须且只能有 category 或 connector 其中之一')
  }
  if (hasCategory) {
    if (!isCategory(selector.category)) {
      throw new Error(
        `未知的工具类别：${String(selector.category)}（可用：${TOOL_CATEGORY_VALUES.join(' / ')}）`,
      )
    }
    return
  }
  const { connector, tool } = selector as { connector: string; tool?: string }
  if (
    !connector ||
    !CONNECTOR_KEY_PATTERN.test(connector) ||
    connector.length > CONNECTOR_KEY_MAX
  ) {
    throw new Error(
      `连接器实例 key 不合法：${connector || '(空)'}（小写字母 / 数字 / 连字符，且不超过 ${CONNECTOR_KEY_MAX} 位）`,
    )
  }
  if (tool !== undefined && !tool.trim()) {
    throw new Error('连接器选择器里的工具名不能为空')
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
    if ('category' in selector) {
      for (const entry of entries) {
        if (entry.category === selector.category) push(entry.key)
      }
      continue
    }
    for (const entry of entries) {
      if (entry.connectorKey !== selector.connector) continue
      if (selector.tool !== undefined && entry.connectorToolName !== selector.tool) continue
      push(entry.key)
    }
  }

  return keys
}
