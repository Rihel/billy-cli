/**
 * 技能（Agent Skills 标准：`SKILL.md` 的 YAML frontmatter + Markdown 正文 + `references/`）。
 *
 * **正文不在这里**：主体只保留"技能在哪、叫什么、什么时候用"，正文与 `references/` 交给
 * **Mastra 的技能加载机制**按需读盘 —— `Agent({ skills: [目录路径] })` 会走
 * `LocalSkillSource` / `WorkspaceSkills`：清单（名字 + 描述）进提示词，
 * 正文与参考文件由 `skill` / `skill_read` 工具按需取。
 *
 * 所以 `SkillLoader` 只做三件事：**发现（扫目录）/ 校验（启动期）/ 授权（按名字取路径）**。
 * 不把几十个技能、上百个参考文件全读进内存（那样只是白占内存，Mastra 本来就能自己按需读）。
 */

/**
 * 「授权全部已加载技能」的占位名。
 *
 * 写在 agent 声明里（`skills: [ALL_SKILLS]`），**装配期展开成真实技能名** ——
 * 于是 `/agent/list` 与 `runs.request_snapshot.skillKeys` 里看到的仍是具体名字，不是这个占位符。
 */
export const ALL_SKILLS = '*'

/** 一个已发现并通过校验的技能（loader 的产物；运行时信封里传给子 agent 的也是它） */
export interface SkillRef {
  /** 技能名（必须与目录名一致，由标准校验规则强制） */
  name: string
  /** 何时用这个技能（模型据此判断是否需要激活） */
  description: string
  /**
   * 技能目录（**绝对路径**）—— 交给 Mastra 的入口：`Agent({ skills: [<path>] })`。
   *
   * 必须绝对：Mastra 的 `LocalSkillSource` 对相对路径按 `process.cwd()` 解析，
   * 而工作目录会随启动方式变化（`pnpm dev` / 容器 / 测试），相对路径必然漂移。
   */
  path: string
}

/** @deprecated 直接用 `SkillRef`；保留别名是为了让调用点读起来仍是"一个技能" */
export type AgentSkill = SkillRef

/** 技能的对外画像（`/agent/list` 返回给前端，说明这个 agent 装了哪些技能） */
export interface AgentSkillMeta {
  name: string
  description: string
}
