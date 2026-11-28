import type { SkillRef } from './skills.types.js'

/**
 * **用户在本轮输入里点名的技能**（`/技能名`）。
 *
 * 入口是前端输入框的斜杠选择，但这里**只认文本**：手打 `/design-taste-frontend` 与
 * 从菜单里选出来是同一条路径（菜单只是把同样的词元插进输入框），不需要额外的 DTO 字段。
 *
 * 三个约束：
 * - 只认**真实存在**的技能名（与可见技能求交集）：`/etc/passwd`、`/help` 这类普通斜杠文本不会误触发；
 * - 词元必须**独占一个词**：前面是行首或空白，后面是空白或结尾；
 * - 一个技能只算一次，顺序按出现顺序（提示词里读起来与用户输入一致）。
 */
const SKILL_TOKEN = /(^|\s)\/([a-z0-9][a-z0-9-]{0,63})(?=\s|$)/g

export const requestedSkillsOf = (message: string, available: readonly SkillRef[]): string[] => {
  if (!message.includes('/')) return []
  const names = new Set(available.map((skill) => skill.name))
  const found: string[] = []
  for (const match of message.matchAll(SKILL_TOKEN)) {
    const name = match[2] as string
    if (!names.has(name) || found.includes(name)) continue
    found.push(name)
  }
  return found
}

/**
 * 系统指令里追加的「本轮显式指定」段落。
 *
 * 为什么要有这一段：技能目录（`## 可用技能`）只给 name + description，模型按描述**自己决定**
 * 要不要用；用户用 `/技能名` 点名时是**明确指令**，必须把"先读正文再动手"说清楚 ——
 * 否则模型可能只凭名字猜流程。
 *
 * 放在运行时（每次请求前拼进这一轮的系统指令），不进会话级提示词快照：
 * 那份快照按设计只在首轮生成、之后逐字复用（前缀缓存），而"本轮点了谁"每轮都不一样。
 */
export const requestedSkillsSection = (names: readonly string[]): string => {
  if (names.length === 0) return ''
  const list = names.map((name) => `- \`${name}\``).join('\n')
  return `\n\n## 本轮显式指定的技能\n${list}\n\n用户在本轮输入里用 \`/技能名\` 点名了上面这些技能。动手前先用 \`file-read\` 读 \`.agents/<技能名>/SKILL.md\`（把 \`<技能名>\` 换成上面的名字），按其中写的流程与约束执行；不要只凭技能名猜内容，也不要把用户这一句当作完整需求。`
}
