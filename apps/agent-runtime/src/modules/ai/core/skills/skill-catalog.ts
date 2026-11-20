import type { SkillRef } from './skills.types.js'

/**
 * 系统指令里的**技能目录段**（`docs/design/workspace-cli-credentials.md` §6.7.3）。
 *
 * 只给 name + description（模型据此判断要不要激活），正文由 `file-read` 读
 * `.agents/<name>/SKILL.md`。主会话与子 agent 共用同一段渲染，避免两处措辞漂移。
 */
export const skillCatalogSection = (skills: readonly SkillRef[]): string =>
  skills.length === 0
    ? ''
    : `\n\n## 可用技能\n${skills.map((skill) => `- \`${skill.name}\`：${skill.description}`).join('\n')}`
