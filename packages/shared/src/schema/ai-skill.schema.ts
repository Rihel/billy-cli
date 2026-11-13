import { z } from 'zod'
import { SkillFileKind, SkillSource } from '../dicts/ai-skill.dict'
import { BasePaginateSchema } from './base.schema'

/**
 * 技能库模块的数据结构（`/ai-skill/*`，后台管理员鉴权）—— 设计 `docs/design/ai-skill-library.md`。
 *
 * 三条与表结构绑定的口径：
 * - **`skillKey` 就是目录名**，创建后不可改（改名 = 新建 + 删除）；
 * - **`description` 是 frontmatter 的 description**（模型据此判断"什么时候用"），
 *   其余 YAML 键收在 `frontmatter` 里，渲染 `SKILL.md` 时拼回去；
 * - **正文不进列表 / 详情**：详情只回文件清单，正文由 `file/read` 单独取（大文件不拖慢详情）。
 */

// ─────────────────────────── 取值约束 ───────────────────────────

/** 技能名（= 目录名）：小写字母 / 数字 / 连字符，与 Agent Skills 标准一致 */
export const SKILL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 技能里的相对文件路径：`SKILL.md`，或 `references/` / `scripts/` / `assets/` 下的文本文件 */
export const SKILL_FILE_PATH_PATTERN =
  /^(?:SKILL\.md|(?:references|scripts|assets)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/

/** 单文件内容上限（字符数；UTF-8 下中文约 3 字节/字，按字符限足够宽松） */
export const SKILL_FILE_MAX_CHARS = 200_000
/** 单个技能最多几个文件 */
export const SKILL_MAX_FILES = 100
/** 单个技能全部文件的内容上限（字符数） */
export const SKILL_TOTAL_MAX_CHARS = 800_000
/** 技能描述上限（Mastra 校验的硬上限是 1024） */
export const SKILL_DESCRIPTION_MAX = 1024

/**
 * 新建技能时的 description 占位。
 *
 * 需求是"新建只填名称、直接进编辑器"，但 Mastra 校验不允许 description 为空
 * （实测：`description: Skill description cannot be empty`）。所以先落一个明确的占位，
 * 编辑器里会提示"待补充" —— 而不是拦着人不让建。
 */
export const SKILL_DESCRIPTION_PLACEHOLDER = '待补充：说明这个技能什么时候用'

/** 技能名（对外模型与入参共用） */
export const SkillKeyField = z
  .string()
  .min(1)
  .max(64)
  .regex(SKILL_KEY_PATTERN, '只能用小写字母 / 数字 / 连字符，且以字母或数字开头')

/** 技能文件相对路径 */
export const SkillFilePathField = z
  .string()
  .min(1)
  .max(200)
  .regex(
    SKILL_FILE_PATH_PATTERN,
    '只能是 SKILL.md，或 references/ scripts/ assets/ 下的文本文件（字母数字 . _ - /）',
  )

/** 来源取值（字典是唯一事实源） */
export const SkillSourceField = z.enum(SkillSource.values as unknown as [string, ...string[]])

/** 文件类型的取值 */
export const SkillFileKindField = z.enum(SkillFileKind.values as unknown as [string, ...string[]])

/** frontmatter 里除 name / description 之外的键（license / compatibility / metadata / allowed-tools …） */
export const SkillFrontmatterSchema = z.record(z.string(), z.unknown()).default({})
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

/** 一个技能文件的元信息（不含正文） */
export const AiSkillFileSchema = z.object({
  /** 相对技能目录的路径（`SKILL.md` / `references/x.md` / `scripts/x.py`） */
  path: z.string(),
  /** 见 `SkillFileKind` 字典：决定编辑器形态 */
  kind: SkillFileKindField,
  /** 字节数（落库时按 UTF-8 计算） */
  size: z.number().int().nonnegative(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
})
export type AiSkillFileModel = z.infer<typeof AiSkillFileSchema>

/** 技能（对外模型） */
export const AiSkillSchema = z.object({
  id: z.string(),
  /** 技能名（= 落盘目录名；创建后不可改） */
  skillKey: z.string(),
  /** 人读标题（列表展示用；省略时前端用 skillKey） */
  title: z.string(),
  /** frontmatter 的 description：什么时候用这个技能（模型据此激活） */
  description: z.string(),
  /** 其余 frontmatter 键（渲染 SKILL.md 时拼回去） */
  frontmatter: z.record(z.string(), z.unknown()),
  /** 总开关：停用后从落盘目录移除，模型看不到它 */
  enabled: z.boolean(),
  /** 见 `SkillSource` 字典 */
  source: SkillSourceField,
  /** 导入来源链接（`source='import'` 时保留，便于追溯 / 重装） */
  originUrl: z.string().nullable(),
  /** 内容版本（每次写 +1，用于乐观锁） */
  version: z.number().int().positive(),
  /** 文件数（含 SKILL.md） */
  fileCount: z.number().int().nonnegative(),
  /** 全部文件内容的 sha256（落盘幂等用） */
  contentHash: z.string().nullable(),
  /** 最后一次成功落盘的时间 */
  lastMaterializedAt: z.union([z.string(), z.date()]).nullable(),
  /** 最后一次校验通过的时间 */
  lastValidatedAt: z.union([z.string(), z.date()]).nullable(),
  /** 校验警告（不拦保存，例如正文过长会占上下文） */
  warnings: z.array(z.string()),
  updatedBy: z.string().nullable(),
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
})
export type AiSkillModel = z.infer<typeof AiSkillSchema>

/** 详情：元信息 + 文件清单（**不含正文**） */
export const AiSkillDetailSchema = AiSkillSchema.extend({
  files: z.array(AiSkillFileSchema),
})
export type AiSkillDetailModel = z.infer<typeof AiSkillDetailSchema>

// ─────────────────────────── 管理台入参 ───────────────────────────

/** 列表：分页 + 可选筛选 */
export const AiSkillListSchema = BasePaginateSchema.extend({
  /** 关键字（匹配 skillKey 与标题） */
  keyword: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
  source: SkillSourceField.optional(),
})
export type AiSkillListDto = z.infer<typeof AiSkillListSchema>

/** 只按 skillKey 定位的入参（详情 / 删除） */
export const AiSkillKeySchema = z.object({ skillKey: SkillKeyField })
export type AiSkillKeyDto = z.infer<typeof AiSkillKeySchema>

/** 新建时可以直接带上的文件（不含 SKILL.md：它由 description + body 拼出来） */
export const AiSkillDraftFileSchema = z.object({
  path: SkillFilePathField.refine((path) => path !== 'SKILL.md', {
    message: 'SKILL.md 由技能描述与正文生成，不要在 files 里传',
  }),
  content: z.string().max(SKILL_FILE_MAX_CHARS),
})
export type AiSkillDraftFile = z.infer<typeof AiSkillDraftFileSchema>

/** 新建技能 */
export const AiSkillCreateSchema = z.object({
  skillKey: SkillKeyField,
  title: z.string().max(128).optional(),
  /** 省略 = 用 `SKILL_DESCRIPTION_PLACEHOLDER`（新建只填名字的直接路径） */
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX).optional(),
  /** SKILL.md 的 Markdown 正文（不含 frontmatter） */
  body: z.string().max(SKILL_FILE_MAX_CHARS).default(''),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  /** 默认启用：建完就能被 agent 用上 */
  enabled: z.boolean().optional().default(true),
  /** 可选的参考文件 / 脚本（一次建完） */
  files: z.array(AiSkillDraftFileSchema).max(SKILL_MAX_FILES).optional(),
})
export type AiSkillCreateDto = z.infer<typeof AiSkillCreateSchema>

/**
 * 更新元信息与开关。
 *
 * `expectedVersion` 是乐观锁：页面拿旧版本保存时明确失败（409），
 * 而不是把别人刚写的内容静默覆盖掉。
 */
export const AiSkillUpdateSchema = z.object({
  skillKey: SkillKeyField,
  title: z.string().max(128).optional(),
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX).optional(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  expectedVersion: z.number().int().positive().optional(),
})
export type AiSkillUpdateDto = z.infer<typeof AiSkillUpdateSchema>

/** 读单个文件正文 */
export const AiSkillFileReadSchema = z.object({
  skillKey: SkillKeyField,
  path: SkillFilePathField,
})
export type AiSkillFileReadDto = z.infer<typeof AiSkillFileReadSchema>

/** 读文件的结果 */
export const AiSkillFileContentSchema = z.object({
  path: z.string(),
  kind: SkillFileKindField,
  content: z.string(),
  version: z.number().int().positive(),
})
export type AiSkillFileContentModel = z.infer<typeof AiSkillFileContentSchema>

/** 写单个文件（新建或覆盖） */
export const AiSkillFileSaveSchema = z.object({
  skillKey: SkillKeyField,
  path: SkillFilePathField,
  content: z.string().max(SKILL_FILE_MAX_CHARS),
  expectedVersion: z.number().int().positive().optional(),
})
export type AiSkillFileSaveDto = z.infer<typeof AiSkillFileSaveSchema>

/** 删单个文件（`SKILL.md` 不允许删） */
export const AiSkillFileRemoveSchema = z.object({
  skillKey: SkillKeyField,
  path: SkillFilePathField,
  expectedVersion: z.number().int().positive().optional(),
})
export type AiSkillFileRemoveDto = z.infer<typeof AiSkillFileRemoveSchema>

/** 从链接导入（skills.sh / GitHub / 直接 Markdown 链接） */
export const AiSkillImportSchema = z.object({
  /** 技能来源链接（或 `owner/repo[/slug]` 简写） */
  url: z.string().min(3).max(1024),
  /** 同名技能已存在时：false（默认）跳过，true 覆盖 */
  overwrite: z.boolean().optional().default(false),
  /** 只导入其中几个（省略 = 全部）；来自预览页勾选 */
  skillKeys: z.array(SkillKeyField).max(50).optional(),
})
export type AiSkillImportDto = z.infer<typeof AiSkillImportSchema>

/** 导入预览：先看这个链接里有哪些技能，再决定导哪些 */
export const AiSkillImportPreviewSchema = z.object({
  url: z.string().min(3).max(1024),
})
export type AiSkillImportPreviewDto = z.infer<typeof AiSkillImportPreviewSchema>

/** 预览里的一个技能 */
export const AiSkillImportPreviewItemSchema = z.object({
  skillKey: z.string(),
  description: z.string(),
  /** 会导入的文件数（含 SKILL.md） */
  fileCount: z.number().int().nonnegative(),
  /** 库里是否已有同名技能（有 = 默认不勾选，需显式覆盖） */
  exists: z.boolean(),
})
export type AiSkillImportPreviewItemModel = z.infer<typeof AiSkillImportPreviewItemSchema>

export const AiSkillImportPreviewResultSchema = z.object({
  /** 人读的来源（`owner/repo[/slug]`） */
  source: z.string(),
  skills: z.array(AiSkillImportPreviewItemSchema),
  /** 扫到但没通过校验的技能（逐个报告） */
  failures: z.array(z.object({ skillKey: z.string(), message: z.string() })),
})
export type AiSkillImportPreviewResultModel = z.infer<typeof AiSkillImportPreviewResultSchema>

/** 导入结果（逐个技能报告，不因为一个坏技能丢掉整批） */
export const AiSkillImportItemSchema = z.object({
  skillKey: z.string(),
  /** created 新建 / updated 覆盖 / skipped 已存在且未要求覆盖 / failed 校验或读取失败 */
  status: z.enum(['created', 'updated', 'skipped', 'failed']),
  /** 失败原因 / 跳过说明（成功时为 null） */
  message: z.string().nullable(),
})
export type AiSkillImportItemModel = z.infer<typeof AiSkillImportItemSchema>

export const AiSkillImportResultSchema = z.object({
  /** 人读的来源 */
  source: z.string(),
  items: z.array(AiSkillImportItemSchema),
  /** 处理的技能数（含失败 / 跳过） */
  total: z.number().int().nonnegative(),
})
export type AiSkillImportResultModel = z.infer<typeof AiSkillImportResultSchema>
