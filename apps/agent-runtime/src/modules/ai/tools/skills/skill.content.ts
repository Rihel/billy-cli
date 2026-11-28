import { validateSkillContent, type SkillContentValidationResult } from '@mastra/core/skills'

/**
 * 技能内容校验的**唯一入口**（设计 `docs/design/ai-skill-library.md` §2.4）。
 *
 * 为什么单独一个文件：
 * - 校验规则归 Mastra（它才是真正加载技能的那一方，抄一套规则必然分裂）；
 * - 但 `@mastra/*` 的依赖要收敛（`pnpm check:mastra` 的允许清单只减不增）——
 *   loader（启动期校验）与 draft（保存前校验）都要用，于是把它收在这一处，
 *   两边都从这里进，依赖条数不增。
 */
export type { SkillContentValidationResult }

/** 校验一份 `SKILL.md` 全文（frontmatter + 正文）；纯函数，无 IO */
export const validateSkillFileContent = (input: {
  content: string
  directoryName?: string
}): SkillContentValidationResult =>
  validateSkillContent({
    content: input.content,
    ...(input.directoryName ? { directoryName: input.directoryName } : {}),
  })
