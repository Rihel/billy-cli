import { Inject, Injectable } from '@nestjs/common'
import dedent from 'dedent'
import { z } from 'zod'
import { SKILL_DESCRIPTION_MAX, SKILL_FILE_MAX_CHARS, SKILL_MAX_FILES } from '@repo/shared'
import { ToolDecl, ToolGroup } from '../core/tools/tool.decorator.js'
import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import { ToolDeniedError } from '../core/tools/tools.types.js'
import type { ToolCallContext } from '../core/tools/tools.types.js'
import { SkillLibraryService } from './skill.service.js'

/**
 * **技能库工具组**（设计 `docs/design/ai-skill-library.md` §2.6）：
 * `skill-list` / `skill-save` / `skill-delete` / `skill-enable`。
 *
 * 为什么是四个粗粒度工具而不是"每个字段一个"：
 * 模型维护一个技能的真实动作是"一次写完正文 + 参考文件"，拆成 write-body / add-file / set-desc
 * 会变成多轮往返，且中途失败留下半个技能。`skill-save` 一次落完。
 *
 * **作用域 `admin`**：技能内容会进入之后每一轮的模型上下文 —— 让普通前台用户写库，
 * 等于开了一条持久的提示词注入通道。子 agent 可以继承（`child: 'allow'`），
 * 但它的工具面是父 agent 授权面的子集，不会额外放大权限。
 */
const SkillListParams = z.object({
  keyword: z.string().max(64).optional().describe('按技能名 / 标题过滤（可选）'),
  enabledOnly: z.boolean().optional().describe('只看已启用的技能（默认 false）'),
})

const SkillSaveParams = z.object({
  skillKey: z
    .string()
    .min(1)
    .max(64)
    .describe('技能名（= 目录名；只能用小写字母 / 数字 / 连字符）。已存在则更新，不存在则新建'),
  description: z
    .string()
    .min(1)
    .max(SKILL_DESCRIPTION_MAX)
    .describe('什么时候用这个技能（会写进 SKILL.md 的 frontmatter，模型据此决定是否激活）'),
  body: z
    .string()
    .max(SKILL_FILE_MAX_CHARS)
    .describe('SKILL.md 的 Markdown 正文（不含 frontmatter；frontmatter 由工具按 skillKey / description 生成）'),
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

const SkillDeleteParams = z.object({
  skillKey: z.string().min(1).max(64).describe('要删除的技能名'),
})

const SkillEnableParams = z.object({
  skillKey: z.string().min(1).max(64).describe('技能名'),
  enabled: z.boolean().describe('true 启用 / false 停用（停用会从落盘目录移除，模型立刻看不到）'),
})

const SkillImportParams = z.object({
  url: z
    .string()
    .min(3)
    .max(1024)
    .describe('技能来源：skills.sh 链接、GitHub 仓库/目录/文件链接，或 owner/repo[/slug] 简写'),
  overwrite: z.boolean().optional().describe('同名技能已存在时是否覆盖（默认 false 跳过）'),
})

const SkillToolConfigSchema = z.object({})

@Injectable()
@ToolGroup({ category: 'core', scope: 'admin', child: 'allow' })
export class SkillTools {
  constructor(@Inject(SkillLibraryService) private readonly skills: SkillLibraryService) {}

  @ToolDecl({
    key: TOOL_KEYS.skillList,
    title: '查看技能库',
    params: SkillListParams,
    config: SkillToolConfigSchema,
    description: dedent`
      列出技能库里的技能（名字 / 何时用 / 是否启用 / 文件数）。

      什么时候用：要新建技能前先看看有没有同名的；或者用户问"你有哪些技能"。
      不要用它读技能正文 —— 用 \`skill\` / \`skill_read\`（运行时自带）。
    `,
  })
  async list(input: z.infer<typeof SkillListParams>) {
    const page = await this.skills.list({
      page: 1,
      size: 100,
      ...(input.keyword ? { keyword: input.keyword } : {}),
      ...(input.enabledOnly ? { enabled: true } : {}),
    })
    const items = page.items.map((skill) => ({
      skillKey: skill.skillKey,
      title: skill.title,
      description: skill.description,
      enabled: skill.enabled,
      source: skill.source,
      fileCount: skill.fileCount,
      version: skill.version,
    }))
    return { total: page.total, items }
  }

  @ToolDecl({
    key: TOOL_KEYS.skillSave,
    title: '新建或更新技能',
    params: SkillSaveParams,
    config: SkillToolConfigSchema,
    description: dedent`
      把一份技能写进技能库（DB 是事实源，服务端会校验并落盘给运行时读）。

      - 已存在的技能按 \`skillKey\` **更新**：description / 正文会整体替换，\`files\` 只增改、不删除已有文件；
      - 不存在的技能**新建**（默认启用）；
      - 正文要写清楚"做什么、按什么步骤做、边界在哪"；参考文件放 \`references/\`，脚本放 \`scripts/\`；
      - 保存后立即生效，不需要重启服务。

      失败时按返回的原因改：名字不合法、description 超长、路径不在 references/ scripts/ assets/、内容过大。

      **不要用 \`run-command\` 往技能目录写文件**：那不会入库，也不算"装了技能"。
    `,
  })
  async save(input: z.infer<typeof SkillSaveParams>) {
    try {
      const existing = await this.skills.detail(input.skillKey).catch(() => null)
      let detail = existing
      if (!existing) {
        detail = await this.skills.create({
          skillKey: input.skillKey,
          title: input.title,
          description: input.description,
          body: input.body,
          ...(input.files ? { files: input.files } : {}),
          enabled: input.enabled ?? true,
        })
      } else {
        detail = await this.skills.update({
          skillKey: input.skillKey,
          ...(input.title !== undefined ? { title: input.title } : {}),
          description: input.description,
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          expectedVersion: existing.version,
        })
        // 正文与文件分开写：元信息更新只重建 frontmatter，正文由 file/save 覆盖
        detail = await this.skills.saveFile({
          skillKey: input.skillKey,
          path: 'SKILL.md',
          content: input.body,
          expectedVersion: detail.version,
        })
        for (const file of input.files ?? []) {
          detail = await this.skills.saveFile({
            skillKey: input.skillKey,
            path: file.path,
            content: file.content,
            expectedVersion: detail.version,
          })
        }
      }
      return {
        ok: true,
        created: !existing,
        skillKey: detail.skillKey,
        version: detail.version,
        enabled: detail.enabled,
        files: detail.files.map((file) => file.path),
      }
    } catch (error) {
      throw new ToolDeniedError('invalid-input', messageOf(error), '按原因修正后重试；技能名只能用小写字母 / 数字 / 连字符')
    }
  }

  @ToolDecl({
    key: TOOL_KEYS.skillImport,
    title: '从链接导入技能',
    params: SkillImportParams,
    config: SkillToolConfigSchema,
    description: dedent`
      从 skills.sh / GitHub 链接下载技能并写入技能库（不是登记链接，内容会进库并落盘）。

      什么时候用：用户给了一个技能页面链接、GitHub 仓库 / 目录链接，或 \`owner/repo\` 简写。
      一个链接里有多个技能时会全部导入（最多 25 个）；只想要其中一个时，先 \`skill-list\` 看名字，
      再用 \`skill-save\` 按名字改，或者让用户打开具体技能的页面复制链接。
    `,
  })
  async importSkill(input: z.infer<typeof SkillImportParams>) {
    try {
      return await this.skills.import({
        url: input.url,
        overwrite: input.overwrite ?? false,
      })
    } catch (error) {
      throw new ToolDeniedError(
        'invalid-input',
        messageOf(error),
        '确认链接是 skills.sh / GitHub 的技能页，并且技能名不是敏感内容',
      )
    }
  }

  @ToolDecl({
    key: TOOL_KEYS.skillDelete,
    title: '删除技能',
    params: SkillDeleteParams,
    config: SkillToolConfigSchema,
    description: dedent`
      从技能库删除一个技能（同时删掉落盘目录，模型立刻看不到）。
      只是暂时不想用请改启用开关（\`skill-enable\`），不要删 —— 删除后历史运行里的名字就找不到对应技能了。
    `,
  })
  async remove(input: z.infer<typeof SkillDeleteParams>) {
    try {
      await this.skills.remove(input.skillKey)
      return { ok: true, skillKey: input.skillKey }
    } catch (error) {
      throw new ToolDeniedError('invalid-input', messageOf(error), '先用 skill-list 确认技能名')
    }
  }

  @ToolDecl({
    key: TOOL_KEYS.skillEnable,
    title: '启用 / 停用技能',
    params: SkillEnableParams,
    config: SkillToolConfigSchema,
    description: dedent`
      开 / 关一个技能。停用后模型看不到它（清单与 skill_read 都以落盘目录为界），但内容仍在库里，随时能再启用。
    `,
  })
  async toggle(input: z.infer<typeof SkillEnableParams>) {
    try {
      const detail = await this.skills.update({
        skillKey: input.skillKey,
        enabled: input.enabled,
      })
      return { ok: true, skillKey: detail.skillKey, enabled: detail.enabled }
    } catch (error) {
      throw new ToolDeniedError('invalid-input', messageOf(error), '先用 skill-list 确认技能名')
    }
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
