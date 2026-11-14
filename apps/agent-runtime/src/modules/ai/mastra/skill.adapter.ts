import type { SkillRef } from '../core/skills/skills.types.js'

/**
 * **我们的技能 → Mastra 的技能入参**（适配器）。
 *
 * 只交**目录路径**（`SkillInput` 的字符串形态）：Mastra 的 `LocalSkillSource` / `WorkspaceSkills`
 * 会自己从磁盘读 `SKILL.md` 与 `references/` —— 清单（名字 + 描述）注入提示词，
 * 正文与参考文件交给 `skill` / `skill_read` 工具按需取（渐进披露）。
 *
 * 为什么不再用 `createSkill` 把正文塞成内联对象：技能库几十个、参考文件上百个，
 * 内联等于启动时全读进内存，且只能带 `references/`、无法懒读；
 * 交给 Mastra 之后，我们只负责"发现 + 校验 + 授权"（见 `SkillLoader`）。
 */
export const toMastraSkills = (skills: readonly SkillRef[]): string[] =>
  skills.map((skill) => skill.path)
