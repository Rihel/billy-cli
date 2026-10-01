/**
 * 已加载的技能（磁盘 `SKILL.md` 的解析结果）。
 *
 * 技能用**Agent Skills 标准格式**（YAML frontmatter 的 `name` / `description` + Markdown 正文），
 * 与仓库根 `.agents/skills/` 完全同构 —— 团队已有心智模型，写技能的规范可直接复用
 * （渐进披露：正文按需加载，`references/` 放长清单与模板）。
 *
 * **这里的类型属于主体**：不带 Mastra 词汇（早先 `AgentSkill` 里挂着 `createSkill` 的产物）。
 * 「技能内容 → Mastra 技能对象」的转换收在 `ai/mastra/agent.adapter.ts`。
 */

/** 技能内容（loader 的产物；运行时信封里传给子 agent 的也是它） */
export interface SkillRef {
  /** 技能名（必须与目录名一致，由标准校验规则强制） */
  name: string
  /** 何时用这个技能（模型据此判断是否激活） */
  description: string
  /** SKILL.md 正文 */
  instructions: string
  /** `references/` 下的文件内容，键为相对 `references/` 的路径 */
  references?: Record<string, string>
  /** 技能目录（诊断用，绝对路径） */
  path?: string
}

/** @deprecated 直接用 `SkillRef`；保留别名是为了让调用点读起来仍是"一个技能" */
export type AgentSkill = SkillRef

/** 技能的对外画像（`/agent/list` 返回给前端，说明这个 agent 装了哪些技能） */
export interface AgentSkillMeta {
  name: string
  description: string
}
