import { createDict } from '../utils'

/**
 * AI 记忆字典（设计 `docs/design/ai-memory.md`）。
 *
 * 长期记忆是一批**用户级事实**：跨会话、可编辑、可删除，v1 不做向量检索。
 */

/**
 * 记忆类型：决定注入时给模型的标签，也决定后台筛选。
 *
 * 四类的边界（写进工具说明，避免模型把一次任务当成长期事实）：
 * - `profile`：稳定画像（职业、常用语言、所在时区）；
 * - `preference`：偏好（回答长短、格式、语气）；
 * - `fact`：事实（项目名、在做什么、明确说过的信息）；
 * - `constraint`：约束（"以后都按这个来"这类要求）。
 */
export const AiMemoryKind = createDict({
  Profile: { label: '画像', value: 'profile' },
  Preference: { label: '偏好', value: 'preference' },
  Fact: { label: '事实', value: 'fact' },
  Constraint: { label: '约束', value: 'constraint' },
})

/** 记忆来源：人在后台建的 / agent 用工具写的 / 轮后自动抽取（P1） */
export const AiMemorySource = createDict({
  Manual: { label: '后台手工', value: 'manual' },
  Tool: { label: 'Agent 写入', value: 'tool' },
  Extract: { label: '自动抽取', value: 'extract' },
})
