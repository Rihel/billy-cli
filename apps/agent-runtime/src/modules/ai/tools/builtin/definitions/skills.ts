import { SKILL_DESCRIPTION_MAX, SKILL_FILE_MAX_CHARS, SKILL_MAX_FILES } from '@repo/shared'
import dedent from 'dedent'
import { z } from 'zod'

export const SkillListParams = z.object({
  keyword: z.string().max(64).optional().describe('按技能名 / 标题过滤（可选）'),
  enabledOnly: z.boolean().optional().describe('只看已启用的技能（默认 false）'),
})

export const SkillSaveParams = z.object({
  skillKey: z
    .string()
    .min(1)
    .max(64)
    .describe('技能名（= 目录名；只能用小写字母 / 数字 / 连字符）。已存在则更新，不存在则新建'),
  description: z
    .string()
    .min(1)
    .max(SKILL_DESCRIPTION_MAX)
    .describe(
      '什么时候用：用户在什么场景 / 说什么话 / 要做什么时应该加载它；这是触发条件，不是内容摘要（会写进 SKILL.md 的 frontmatter，模型据此决定是否激活）',
    ),
  body: z
    .string()
    .max(SKILL_FILE_MAX_CHARS)
    .describe(
      'SKILL.md 的 Markdown 正文（不含 frontmatter；frontmatter 由工具按 skillKey / description 生成）',
    ),
  title: z.string().max(128).optional().describe('人读标题（省略 = 用 skillKey）'),
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(200)
          .describe('相对技能目录的路径：references/xxx.md 或 scripts/xxx.py'),
        content: z.string().max(SKILL_FILE_MAX_CHARS).describe('文件内容'),
      }),
    )
    .max(SKILL_MAX_FILES)
    .optional()
    .describe('要一并写入的参考文件 / 脚本（只增改，不删除已有文件）'),
  enabled: z.boolean().optional().describe('是否启用（默认 true；停用后模型看不到这个技能）'),
})

export const SkillFileSaveParams = z.object({
  skillKey: z.string().min(1).max(64).describe('技能名'),
  path: z
    .string()
    .min(1)
    .max(200)
    .describe(
      '相对技能目录的路径：references/xxx.md、scripts/xxx.py 或 assets/xxx；写入 SKILL.md 请用 skill-save',
    ),
  content: z.string().max(SKILL_FILE_MAX_CHARS).describe('文件完整内容（覆盖写）'),
  expectedVersion: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('乐观锁版本；并发修改时传当前版本'),
})

export const SkillFileAppendParams = z.object({
  skillKey: z.string().min(1).max(64).describe('技能名'),
  path: z
    .string()
    .min(1)
    .max(200)
    .describe(
      '相对技能目录的路径：references/xxx.md、scripts/xxx.py 或 assets/xxx；不能是 SKILL.md',
    ),
  content: z.string().max(SKILL_FILE_MAX_CHARS).describe('追加内容（不会自动补换行）'),
  expectedVersion: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('乐观锁版本；并发修改时传当前版本'),
})

export const SkillDeleteParams = z.object({
  skillKey: z.string().min(1).max(64).describe('要删除的技能名'),
})

export const SkillEnableParams = z.object({
  skillKey: z.string().min(1).max(64).describe('技能名'),
  enabled: z.boolean().describe('true 启用 / false 停用（停用会从落盘目录移除，模型立刻看不到）'),
})

export const SkillImportParams = z.object({
  url: z
    .string()
    .min(3)
    .max(1024)
    .describe('技能来源：skills.sh 链接、GitHub 仓库/目录/文件链接，或 owner/repo[/slug] 简写'),
  overwrite: z.boolean().optional().describe('同名技能已存在时是否覆盖（默认 false 跳过）'),
})

const base = {
  category: 'core',
  scope: 'admin',
  executor: 'server',
  version: 1,
} as const

export const SKILL_LIST_TOOL = {
  ...base,
  key: 'skill-list',
  title: '查看技能库',
  params: SkillListParams,
  description: dedent`
    列出技能库里的技能（名字 / 何时用 / 是否启用 / 文件数）。

    什么时候用：要新建技能前先看看有没有同名的；或者用户问"你有哪些技能"。
    不要用它读技能正文 —— 用 \`skill\` / \`skill_read\`（运行时自带）。
  `,
} as const

export const SKILL_SAVE_TOOL = {
  ...base,
  key: 'skill-save',
  title: '新建或更新技能',
  params: SkillSaveParams,
  description: dedent`
    把一份技能写进技能库（DB 是事实源，服务端会校验并落盘给运行时读）。

    - 已存在的技能按 \`skillKey\` **更新**：description / 正文会整体替换，\`files\` 只增改、不删除已有文件；
    - 不存在的技能**新建**（默认启用）；
    - 正文要写清楚"做什么、按什么步骤做、边界在哪"；参考文件放 \`references/\`，脚本放 \`scripts/\`；
    - 保存后立即生效，不需要重启服务。

    失败时按返回的原因改：名字不合法、description 超长、路径不在 references/ scripts/ assets/、内容过大。

    **不要用 \`bash\` 往技能目录写文件**：那不会入库，也不算"装了技能"。
  `,
} as const

export const SKILL_FILE_SAVE_TOOL = {
  ...base,
  key: 'skill-file-save',
  title: '写入技能文件',
  params: SkillFileSaveParams,
  description: dedent`
    新建或覆盖技能目录里的单个文件（references / scripts / assets）。

    什么时候用：给已有技能补一份参考文档、脚本或素材；不用把 SKILL.md 正文整篇重发。
    不能写 SKILL.md：技能正文用 \`skill-save\`。路径必须在 references/ scripts/ assets/ 下；
    写入后立即生效，不需要重启。
  `,
} as const

export const SKILL_FILE_APPEND_TOOL = {
  ...base,
  key: 'skill-file-append',
  title: '追加技能文件内容',
  params: SkillFileAppendParams,
  description: dedent`
    在技能目录已有文件末尾追加内容（不存在则创建）；只 Append，不整文件覆盖。

    什么时候用：往 references/xxx.md 里继续补来源、往 scripts/xxx.py 里追加函数；
    追加内容不会自动补换行。不能写 SKILL.md：技能正文用 \`skill-save\`。
    写入后立即生效，不需要重启。
  `,
} as const

export const SKILL_IMPORT_TOOL = {
  ...base,
  key: 'skill-import',
  title: '从链接导入技能',
  params: SkillImportParams,
  description: dedent`
    从 skills.sh / GitHub 链接下载技能并写入技能库（不是登记链接，内容会进库并落盘）。

    什么时候用：用户给了一个技能页面链接、GitHub 仓库 / 目录链接，或 \`owner/repo\` 简写。
    一个链接里有多个技能时会全部导入（最多 25 个）；只想要其中一个时，先 \`skill-list\` 看名字，
    再用 \`skill-save\` 按名字改，或者让用户打开具体技能的页面复制链接。
  `,
} as const

export const SKILL_DELETE_TOOL = {
  ...base,
  key: 'skill-delete',
  title: '删除技能',
  params: SkillDeleteParams,
  description: dedent`
    从技能库删除一个技能（同时删掉落盘目录，模型立刻看不到）。
    只是暂时不想用请改启用开关（\`skill-enable\`），不要删 —— 删除后历史运行里的名字就找不到对应技能了。
  `,
} as const

export const SKILL_ENABLE_TOOL = {
  ...base,
  key: 'skill-enable',
  title: '启用 / 停用技能',
  params: SkillEnableParams,
  description: dedent`
    开 / 关一个技能。停用后模型看不到它（清单与 skill_read 都以落盘目录为界），但内容仍在库里，随时能再启用。
  `,
} as const
