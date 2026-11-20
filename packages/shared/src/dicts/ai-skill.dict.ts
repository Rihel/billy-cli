import { createDict } from '../utils'

/**
 * 技能库字典（设计 `docs/design/ai-skill-library.md`）。
 *
 * 技能 = Agent Skills 标准的一个目录：`SKILL.md`（YAML frontmatter + Markdown 正文）+
 * `references/` + `scripts/`。库里的每一行在落盘后与一个磁盘目录一一对应，
 * 因为 Mastra 只认目录路径（正文与参考文件由它按需读盘）。
 */

/** 技能的来源：人在线建的 / 从本机路径导入的 / agent 用工具建的 */
export const SkillSource = createDict({
  /** 后台编辑器里新建 */
  Online: { label: '在线创建', value: 'online' },
  /** 从 skills.sh / GitHub 等链接下载后导入（读进库，不是只登记链接） */
  Import: { label: '链接导入', value: 'import' },
  /** agent 通过 `skill-save` 工具写入 */
  Agent: { label: 'Agent 创建', value: 'agent' },
  /** 随版本发布的内置技能（种子入库，全员可见） */
  Builtin: { label: '内置', value: 'builtin' },
})

/**
 * 技能归属范围（`docs/design/workspace-cli-credentials.md` §6.7.1）。
 *
 * - `platform`：平台级技能，默认不对外开放，需显式授予；
 * - `personal`：个人技能，仅 owner 可见。
 */
export const SkillScope = createDict({
  Platform: { label: '平台', value: 'platform' },
  Personal: { label: '个人', value: 'personal' },
})

/**
 * 技能文件的类型：决定编辑器用块编辑器还是代码编辑器。
 *
 * 不按扩展名逐个列，而是分两类 —— 前端只需要知道"能不能渲染成富文本"。
 */
export const SkillFileKind = createDict({
  /** Markdown：`SKILL.md` 与 `references/*.md` */
  Markdown: { label: 'Markdown', value: 'markdown' },
  /** 脚本 / 其他文本：`scripts/*.py` / `*.js` 等 */
  Code: { label: '代码', value: 'code' },
})
