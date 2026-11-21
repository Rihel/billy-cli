import type { AiSkillModel } from '@repo/shared'

/**
 * 输入框斜杠命令的纯函数（便于单测）。
 *
 * 口径（产品定的）：**`/` 必须是 `trim()` 后的第一个字符**才触发菜单；
 * 打出空白就表示"已经选完"，菜单关闭。选中后把 `/技能名` 作为一个词元插进文本，
 * 因此"输入框里的内容"仍然是一段普通文本 —— 没有富文本、没有额外的 DTO 字段，
 * 服务端只按 `/技能名` 词元识别（见 `requestedSkillsOf`）。
 */

/** 斜杠菜单的查询词；`null` = 菜单不该出现 */
export const slashQueryOf = (text: string): string | null => {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) return null
  const rest = trimmed.slice(1)
  // 已经打出空白：命令名结束（选中过 / 用户手打了别的字），菜单收起
  if (/\s/.test(rest)) return null
  return rest
}

/** 菜单候选：只认启用中的技能，按关键字匹配 `skillKey` 与标题，按名字排序 */
export const filterSkills = (skills: readonly AiSkillModel[], query: string): AiSkillModel[] => {
  const keyword = query.trim().toLowerCase()
  return skills
    .filter((skill) => skill.enabled)
    .filter(
      (skill) =>
        keyword === '' ||
        skill.skillKey.toLowerCase().includes(keyword) ||
        skill.title.toLowerCase().includes(keyword),
    )
    .sort((left, right) => left.skillKey.localeCompare(right.skillKey))
    .slice(0, 20)
}

/**
 * 输入框里**已经选中的技能**（`/技能名` 词元 ∩ 已知技能）。
 *
 * 与真实技能求交集是必须的：否则 `/etc/passwd`、`/help` 这类普通斜杠文本也会变成标签。
 * 顺序按出现顺序，重复只算一次。
 */
export const selectedSkillKeysOf = (text: string, knownKeys: readonly string[]): string[] => {
  const known = new Set(knownKeys)
  const found: string[] = []
  for (const match of text.matchAll(/(^|\s)\/([a-z0-9][a-z0-9-]{0,63})(?=\s|$)/g)) {
    const key = match[2] as string
    if (!known.has(key) || found.includes(key)) continue
    found.push(key)
  }
  return found
}

/** 选中一个技能：把正在输入的 `/query` 换成 `/技能名 `，其余文字原样保留 */
export const insertSkillToken = (text: string, key: string): string => {
  const trimmed = text.trimStart()
  const rest = trimmed.startsWith('/') ? trimmed.slice(1).replace(/^\S*/, '') : trimmed
  return `/${key} ${rest.replace(/^\s+/, '')}`
}

/** 删掉某个技能的词元（标签上的 ×） */
export const removeSkillToken = (text: string, key: string): string =>
  text
    .replace(new RegExp(`(^|\\s)/${key}(?=\\s|$)`, 'g'), '$1')
    .replace(/^[ \t]+/, '')
    .replace(/[ \t]{2,}/g, ' ')
