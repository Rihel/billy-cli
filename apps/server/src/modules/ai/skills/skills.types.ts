import type { InlineSkill } from '@mastra/core/skills'

/**
 * 已加载的技能（磁盘 `SKILL.md` 的解析结果）。
 *
 * 技能用**Agent Skills 标准格式**（YAML frontmatter 的 `name` / `description` + Markdown 正文），
 * 与仓库根 `.agents/skills/` 完全同构 —— 团队已有心智模型，写技能的规范可直接复用
 * （渐进披露：正文按需加载，`references/` 放长清单与模板）。
 */
export interface AgentSkill {
  /** 技能名（必须与目录名一致，由 Mastra 的校验规则强制） */
  name: string
  /** 何时用这个技能（模型据此判断是否激活） */
  description: string
  /** SKILL.md 正文 */
  instructions: string
  /** 技能目录（诊断用，绝对路径） */
  path: string
  /** `references/` 下的文件内容，键为相对 `references/` 的路径 */
  references: Record<string, string>
  /** 交给 Agent 的 Mastra 技能对象（`createSkill` 产物） */
  skill: InlineSkill
}

/** 技能的对外画像（`/agent/list` 返回给前端，说明这个 agent 装了哪些技能） */
export interface AgentSkillMeta {
  name: string
  description: string
}
