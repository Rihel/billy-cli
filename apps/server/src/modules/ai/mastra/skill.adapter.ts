import { createSkill, type InlineSkill } from '@mastra/core/skills'
import type { SkillRef } from '../skills/skills.types.js'

/**
 * **我们的技能 → Mastra 的技能对象**（适配器）：主体只认 `SkillRef`（名字 / 说明 / 正文 / 参考文件），
 * 这一层负责把它交给 `createSkill`。技能内容由 `SkillLoader` 从磁盘读好，转换是纯映射。
 */
export const toMastraSkills = (skills: readonly SkillRef[]): InlineSkill[] =>
  skills.map((skill) =>
    createSkill({
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      ...(skill.references ? { references: skill.references } : {}),
    }),
  )
