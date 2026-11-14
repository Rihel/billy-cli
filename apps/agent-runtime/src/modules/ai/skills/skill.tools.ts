import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { ToolDecl, ToolGroup } from '../core/tools/tool.decorator.js'
import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import { ToolDeniedError } from '../core/tools/tools.types.js'
import {
  SKILL_DELETE_TOOL,
  SKILL_ENABLE_TOOL,
  SKILL_FILE_APPEND_TOOL,
  SKILL_FILE_SAVE_TOOL,
  SKILL_IMPORT_TOOL,
  SKILL_LIST_TOOL,
  SKILL_SAVE_TOOL,
} from '@repo/tool-catalog'
import { SkillLibraryService } from './skill.service.js'

/**
 * **技能库工具组**（设计 `docs/design/ai-skill-library.md` §2.6）：
 * `skill-list` / `skill-save` / `skill-file-save` / `skill-file-append` /
 * `skill-delete` / `skill-enable`。
 *
 * 为什么是四个粗粒度工具而不是"每个字段一个"：
 * 模型维护一个技能的真实动作是"一次写完正文 + 参考文件"，拆成 write-body / add-file / set-desc
 * 会变成多轮往返，且中途失败留下半个技能。`skill-save` 一次落完。
 *
 * **作用域 `admin`**：技能内容会进入之后每一轮的模型上下文 —— 让普通前台用户写库，
 * 等于开了一条持久的提示词注入通道。子 agent 可以继承（`child: 'allow'`），
 * 但它的工具面是父 agent 授权面的子集，不会额外放大权限。
 */
const SkillToolConfigSchema = z.object({})

@Injectable()
@ToolGroup({ category: 'core', scope: 'admin', child: 'allow' })
export class SkillTools {
  constructor(@Inject(SkillLibraryService) private readonly skills: SkillLibraryService) {}

  @ToolDecl({
    key: TOOL_KEYS.skillList,
    title: SKILL_LIST_TOOL.title,
    params: SKILL_LIST_TOOL.params,
    config: SkillToolConfigSchema,
    description: SKILL_LIST_TOOL.description,
  })
  async list(input: z.infer<typeof SKILL_LIST_TOOL.params>) {
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
    title: SKILL_SAVE_TOOL.title,
    params: SKILL_SAVE_TOOL.params,
    config: SkillToolConfigSchema,
    description: SKILL_SAVE_TOOL.description,
  })
  async save(input: z.infer<typeof SKILL_SAVE_TOOL.params>) {
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
      throw new ToolDeniedError(
        'invalid-input',
        messageOf(error),
        '按原因修正后重试；技能名只能用小写字母 / 数字 / 连字符',
      )
    }
  }

  @ToolDecl({
    key: TOOL_KEYS.skillFileSave,
    title: SKILL_FILE_SAVE_TOOL.title,
    params: SKILL_FILE_SAVE_TOOL.params,
    config: SkillToolConfigSchema,
    description: SKILL_FILE_SAVE_TOOL.description,
  })
  async saveFile(input: z.infer<typeof SKILL_FILE_SAVE_TOOL.params>) {
    this.assertNotSkillBody(input.path)
    try {
      const detail = await this.skills.saveFile({
        skillKey: input.skillKey,
        path: input.path,
        content: input.content,
        ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
      })
      return {
        ok: true,
        skillKey: detail.skillKey,
        version: detail.version,
        path: input.path,
        files: detail.files.map((file) => file.path),
      }
    } catch (error) {
      throw new ToolDeniedError(
        'invalid-input',
        messageOf(error),
        '按原因修正后重试；路径只能放在 references/ scripts/ assets/ 下',
      )
    }
  }

  @ToolDecl({
    key: TOOL_KEYS.skillFileAppend,
    title: SKILL_FILE_APPEND_TOOL.title,
    params: SKILL_FILE_APPEND_TOOL.params,
    config: SkillToolConfigSchema,
    description: SKILL_FILE_APPEND_TOOL.description,
  })
  async appendFile(input: z.infer<typeof SKILL_FILE_APPEND_TOOL.params>) {
    this.assertNotSkillBody(input.path)
    try {
      const existing = await this.skills.readFile(input.skillKey, input.path).catch(() => null)
      const content = `${existing?.content ?? ''}${input.content}`
      const detail = await this.skills.saveFile({
        skillKey: input.skillKey,
        path: input.path,
        content,
        ...((input.expectedVersion ?? existing?.version)
          ? { expectedVersion: input.expectedVersion ?? existing!.version }
          : {}),
      })
      return {
        ok: true,
        skillKey: detail.skillKey,
        version: detail.version,
        path: input.path,
        bytes: content.length,
        files: detail.files.map((file) => file.path),
      }
    } catch (error) {
      throw new ToolDeniedError(
        'invalid-input',
        messageOf(error),
        '先用 skill-list 确认技能存在；路径只能放在 references/ scripts/ assets/ 下',
      )
    }
  }

  /** 技能正文有专用工具（skill-save），避免这里第二次拼 frontmatter */
  private assertNotSkillBody(path: string): void {
    if (path === 'SKILL.md') {
      throw new ToolDeniedError(
        'invalid-input',
        'SKILL.md 请用 skill-save 整体更新，不要用文件工具',
      )
    }
  }

  @ToolDecl({
    key: TOOL_KEYS.skillImport,
    title: SKILL_IMPORT_TOOL.title,
    params: SKILL_IMPORT_TOOL.params,
    config: SkillToolConfigSchema,
    description: SKILL_IMPORT_TOOL.description,
  })
  async importSkill(input: z.infer<typeof SKILL_IMPORT_TOOL.params>) {
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
    title: SKILL_DELETE_TOOL.title,
    params: SKILL_DELETE_TOOL.params,
    config: SkillToolConfigSchema,
    description: SKILL_DELETE_TOOL.description,
  })
  async remove(input: z.infer<typeof SKILL_DELETE_TOOL.params>) {
    try {
      await this.skills.remove(input.skillKey)
      return { ok: true, skillKey: input.skillKey }
    } catch (error) {
      throw new ToolDeniedError('invalid-input', messageOf(error), '先用 skill-list 确认技能名')
    }
  }

  @ToolDecl({
    key: TOOL_KEYS.skillEnable,
    title: SKILL_ENABLE_TOOL.title,
    params: SKILL_ENABLE_TOOL.params,
    config: SkillToolConfigSchema,
    description: SKILL_ENABLE_TOOL.description,
  })
  async toggle(input: z.infer<typeof SKILL_ENABLE_TOOL.params>) {
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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
