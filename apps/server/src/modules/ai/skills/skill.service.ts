import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { AppLogger, type PageQueryResult } from '@repo/kits'
import {
  SKILL_DESCRIPTION_PLACEHOLDER,
  SKILL_FILE_MAX_CHARS,
  SKILL_MAX_FILES,
  SKILL_TOTAL_MAX_CHARS,
  SkillFileKind,
  SkillSource,
  type AiSkillCreateDto,
  type AiSkillDetailModel,
  type AiSkillFileContentModel,
  type AiSkillFileModel,
  type AiSkillFileRemoveDto,
  type AiSkillFileSaveDto,
  type AiSkillImportDto,
  type AiSkillImportItemModel,
  type AiSkillImportPreviewDto,
  type AiSkillImportPreviewResultModel,
  type AiSkillImportResultModel,
  type AiSkillListDto,
  type AiSkillModel,
  type AiSkillUpdateDto,
} from '@repo/shared'
import type { AiSkillEntity } from '../../../database/entities/ai-skill-entity.js'
import type { AiSkillFileEntity } from '../../../database/entities/ai-skill-file-entity.js'
import {
  hashSkillFiles,
  parseSkillMarkdown,
  validateSkillDraft,
  type SkillDraft,
} from '../core/skills/skill.draft.js'
import { SkillLoader } from '../core/skills/skill.loader.js'
import { SkillMaterializer } from '../core/skills/skill.materializer.js'
import {
  isMarkdownFile,
  normalizeSkillFilePath,
  normalizeSkillKey,
  SKILL_FILE,
} from '../core/skills/skill.paths.js'
import {
  SkillFileInvalidError,
  SkillImportFailedError,
  SkillInvalidError,
  SkillKeyConflictError,
  SkillMaterializeFailedError,
  SkillNotFoundError,
  SkillVersionConflictError,
} from './skill.errors.js'
import { fetchRemoteSkillSources, type RemoteSkillSource } from './skill.remote.js'
import { SkillRepository } from './skill.repository.js'

/**
 * 技能库服务（`/ai-skill/*` 与 `skill-*` 工具共用一条链路）—— 设计 `docs/design/ai-skill-library.md`。
 *
 * 五条口径：
 * - **DB 是事实源，磁盘是投影**：每次写完成库再 `materializer.sync()`，失败如实报错（启动自愈）；
 * - **写完必须 `skillLoader.reload()`**：否则 `ALL_SKILLS` 还是旧名单，在线新建的技能要重启才生效；
 * - **`SKILL.md` 由「description + frontmatter + 正文」拼出来**：页面 / agent / 导入三条入口
 *   都走同一个 `validateSkillDraft`，不会出现"页面存得进、Mastra 加载不了"；
 * - **乐观锁**：保存带 `expectedVersion`，条件更新失败就 3417，绝不静默覆盖别人的改动；
 * - **停用 = 标记 + 删目录**：只改库不删目录，Mastra 那边照样看得见（那个目录就是它的权限边界）。
 */
@Injectable()
export class SkillLibraryService implements OnApplicationBootstrap {
  constructor(
    @Inject(SkillRepository) private readonly repository: SkillRepository,
    @Inject(SkillMaterializer) private readonly materializer: SkillMaterializer,
    @Inject(SkillLoader) private readonly loader: SkillLoader,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * 启动自愈：把已启用的技能全部落盘，并清掉库里不存在的目录。
   *
   * 失败**不拦启动**（磁盘问题不该让整个服务起不来）：记错误日志，接口照常可用；
   * 下一次保存 / 重启会再同步。
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const skills = await this.repository.listAll(true)
      const files = await this.repository.filesOfMany(skills.map((skill) => skill.id))
      const grouped = groupBySkill(files)
      await this.materializer.syncAll(
        skills.map((skill) => ({
          skillKey: skill.skillKey,
          files: (grouped.get(skill.id) ?? []).map(toFileInput),
        })),
      )
    } catch (error) {
      this.logger.error('ai.skills.bootstrap_sync_failed', { error: messageOf(error) })
    }
  }

  /** 列表 */
  async list(query: AiSkillListDto): Promise<PageQueryResult<AiSkillModel>> {
    const page = await this.repository.page(query)
    return { ...page, items: page.items.map((entity) => toModel(entity)) }
  }

  /** 详情：元信息 + 文件清单（正文由 `readFile` 单独取） */
  async detail(skillKey: string): Promise<AiSkillDetailModel> {
    const entity = await this.requireSkill(skillKey)
    const files = await this.repository.filesOf(entity.id)
    return { ...toModel(entity), files: files.map(toFileMeta) }
  }

  /** 新建（在线创建） */
  async create(input: AiSkillCreateDto): Promise<AiSkillDetailModel> {
    const skillKey = normalizeSkillOrThrow(input.skillKey)
    if (await this.repository.find(skillKey)) throw new SkillKeyConflictError(skillKey)

    const draft: SkillDraft = {
      skillKey,
      description: input.description?.trim() || SKILL_DESCRIPTION_PLACEHOLDER,
      frontmatter: input.frontmatter ?? {},
      body: input.body ?? '',
    }
    const validation = validateSkillDraft(draft)
    if (!validation.valid) throw new SkillInvalidError(validation.errors)

    const files = [
      { path: SKILL_FILE, content: validation.content },
      ...(input.files ?? []).map((file) => ({ path: file.path, content: file.content })),
    ]
    this.assertLimits(files)

    const entity = await this.repository.create(
      {
        skillKey,
        title: input.title ?? skillKey,
        description: draft.description,
        frontmatter: draft.frontmatter,
        enabled: input.enabled ?? true,
        source: SkillSource._source.Online.value,
        lastValidatedAt: new Date(),
        warnings: validation.warnings,
      },
      files,
    )

    this.logger.log('ai.skill.created', { skillKey, files: files.length, enabled: entity.enabled })
    await this.afterWrite(entity)
    return this.detail(skillKey)
  }

  /**
   * 更新元信息 / 开关。
   *
   * 只有**内容相关字段**（description / frontmatter）变化才重建 `SKILL.md` 并推进版本；
   * 单纯启停不动版本，避免把别人正开着的编辑器判成冲突。
   */
  async update(input: AiSkillUpdateDto): Promise<AiSkillDetailModel> {
    const entity = await this.requireSkill(input.skillKey)
    const description = input.description ?? entity.description
    const frontmatter = input.frontmatter ?? entity.frontmatter
    const title = input.title ?? entity.title
    const contentChanged =
      description !== entity.description || !sameJson(frontmatter, entity.frontmatter)

    let warnings = entity.warnings
    let nextContent: string | null = null
    if (contentChanged) {
      const files = await this.repository.filesOf(entity.id)
      const entry = files.find((file) => file.path === SKILL_FILE)
      if (!entry) throw new SkillFileInvalidError(`缺少 ${SKILL_FILE}`)
      const parsed = parseSkillMarkdown(entry.content, entity.skillKey)
      if (!parsed.parsed) throw new SkillInvalidError(parsed.errors)

      const validation = validateSkillDraft({
        skillKey: entity.skillKey,
        description,
        frontmatter,
        body: parsed.parsed.body,
      })
      if (!validation.valid) throw new SkillInvalidError(validation.errors)
      warnings = validation.warnings
      nextContent = validation.content
    }

    await this.repository.transaction(async (manager) => {
      if (contentChanged) {
        const version = await this.repository.bumpVersion(entity.id, input.expectedVersion, manager)
        if (version === null) throw new SkillVersionConflictError(entity.skillKey)
        await this.repository.update(
          entity.id,
          {
            title,
            description,
            frontmatter,
            warnings,
            lastValidatedAt: new Date(),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          },
          manager,
        )
        await this.repository.saveFile(manager, entity.id, {
          path: SKILL_FILE,
          content: nextContent ?? '',
        })
        return
      }

      const patch: Partial<AiSkillEntity> = { title }
      if (input.enabled !== undefined) patch.enabled = input.enabled
      await this.repository.update(entity.id, patch, manager)
    })

    this.logger.log('ai.skill.updated', {
      skillKey: entity.skillKey,
      contentChanged,
      enabled: input.enabled ?? entity.enabled,
    })
    await this.afterWrite(await this.requireSkill(entity.skillKey))
    return this.detail(entity.skillKey)
  }

  /** 软删技能 + 删落盘目录 */
  async remove(skillKey: string): Promise<{ ok: boolean }> {
    const entity = await this.requireSkill(skillKey)
    await this.repository.softRemove(entity.id)
    await this.materializer.remove(entity.skillKey).catch((error: unknown) => {
      this.logger.error('ai.skill.remove_dir_failed', {
        skillKey: entity.skillKey,
        error: messageOf(error),
      })
    })
    this.loader.reload()
    this.logger.warn('ai.skill.removed', { skillKey: entity.skillKey })
    return { ok: true }
  }

  /** 读单个文件正文 */
  async readFile(skillKey: string, path: string): Promise<AiSkillFileContentModel> {
    const entity = await this.requireSkill(skillKey)
    const normalized = normalizeFilePathOrThrow(path)
    const file = await this.repository.fileOf(entity.id, normalized)
    if (!file) throw new SkillFileInvalidError(`文件不存在：${normalized}`)
    return {
      path: file.path,
      kind: fileKind(file.path),
      content: file.content,
      version: entity.version,
    }
  }

  /**
   * 写单个文件（新建或覆盖）。
   *
   * `SKILL.md` 的正文要按当前元信息重新拼装并校验；其它文件只看路径与大小。
   */
  async saveFile(input: AiSkillFileSaveDto): Promise<AiSkillDetailModel> {
    const entity = await this.requireSkill(input.skillKey)
    const path = normalizeFilePathOrThrow(input.path)

    let content = input.content
    let warnings = entity.warnings
    if (path === SKILL_FILE) {
      const validation = validateSkillDraft({
        skillKey: entity.skillKey,
        description: entity.description,
        frontmatter: entity.frontmatter,
        body: input.content,
      })
      if (!validation.valid) throw new SkillInvalidError(validation.errors)
      content = validation.content
      warnings = validation.warnings
    }

    const current = await this.repository.filesOf(entity.id)
    const next = current
      .map((file) => ({ path: file.path, content: file.content }))
      .filter((file) => file.path !== path)
    next.push({ path, content })
    this.assertLimits(next)

    await this.repository.transaction(async (manager) => {
      const version = await this.repository.bumpVersion(entity.id, input.expectedVersion, manager)
      if (version === null) throw new SkillVersionConflictError(entity.skillKey)
      await this.repository.saveFile(manager, entity.id, { path, content })
      await this.repository.update(entity.id, { warnings, lastValidatedAt: new Date() }, manager)
    })

    this.logger.log('ai.skill.file_saved', { skillKey: entity.skillKey, path })
    await this.afterWrite(await this.requireSkill(entity.skillKey))
    return this.detail(entity.skillKey)
  }

  /** 删单个文件（`SKILL.md` 不允许删） */
  async removeFile(input: AiSkillFileRemoveDto): Promise<AiSkillDetailModel> {
    const entity = await this.requireSkill(input.skillKey)
    const path = normalizeFilePathOrThrow(input.path)
    if (path === SKILL_FILE) throw new SkillFileInvalidError(`${SKILL_FILE} 是技能入口，不能删除`)

    await this.repository.transaction(async (manager) => {
      const version = await this.repository.bumpVersion(entity.id, input.expectedVersion, manager)
      if (version === null) throw new SkillVersionConflictError(entity.skillKey)
      await this.repository.removeFile(manager, entity.id, path)
    })

    this.logger.log('ai.skill.file_removed', { skillKey: entity.skillKey, path })
    await this.afterWrite(await this.requireSkill(entity.skillKey))
    return this.detail(entity.skillKey)
  }

  /**
   * 从链接导入（**下载后写入库**，不是登记链接）。
   *
   * 支持 skills.sh / GitHub 仓库、目录、文件页与直接 Markdown 链接；
   * 一个链接下有多个技能时全部导入（可用 `skillKeys` 只导其中几个）。
   * **逐个技能报告**：一个坏技能不影响整批；同名已存在时按 `overwrite` 跳过或覆盖。
   */
  async import(input: AiSkillImportDto): Promise<AiSkillImportResultModel> {
    const fetched = await this.fetchOrThrow(input.url)
    const selected = input.skillKeys?.length
      ? fetched.sources.filter((source) => input.skillKeys!.includes(source.skillKey))
      : fetched.sources
    if (selected.length === 0 && fetched.failures.length === 0) {
      throw new SkillImportFailedError('没有匹配的技能（勾选的技能名不在这个链接里）')
    }

    const items: AiSkillImportItemModel[] = []
    for (const source of selected) {
      items.push(await this.importOne(source, input.overwrite ?? false))
    }
    // 扫描阶段就失败的目录也要如实报告（否则用户以为"都导进来了"）
    for (const failure of fetched.failures) {
      items.push({ skillKey: failure.skillKey, status: 'failed', message: failure.message })
    }
    this.logger.log('ai.skill.imported', {
      url: input.url,
      source: fetched.label,
      total: items.length,
      created: items.filter((item) => item.status === 'created').length,
      updated: items.filter((item) => item.status === 'updated').length,
      failed: items.filter((item) => item.status === 'failed').length,
    })
    return { source: fetched.label, items, total: items.length }
  }

  /**
   * 导入预览：先看这个链接里有哪些技能、哪些已存在，再决定导哪些 / 是否覆盖。
   *
   * 预览与导入各自下载一次（技能仓库不大；换来的好处是不用维护"预取缓存"的生命周期）。
   */
  async preview(input: AiSkillImportPreviewDto): Promise<AiSkillImportPreviewResultModel> {
    const fetched = await this.fetchOrThrow(input.url)
    const skills = []
    for (const source of fetched.sources) {
      skills.push({
        skillKey: source.skillKey,
        description: source.description,
        fileCount: source.files.length,
        exists: Boolean(await this.repository.find(source.skillKey)),
      })
    }
    return { source: fetched.label, skills, failures: fetched.failures }
  }

  // ─────────────────────────── 内部 ───────────────────────────

  /** 下载 + 把"连来源都解析不了 / 整包下载失败"翻译成业务错误 */
  private async fetchOrThrow(url: string) {
    try {
      return await fetchRemoteSkillSources(url)
    } catch (error) {
      throw new SkillImportFailedError(messageOf(error))
    }
  }

  private async importOne(
    source: RemoteSkillSource,
    overwrite: boolean,
  ): Promise<AiSkillImportItemModel> {
    const entry = source.files.find((file) => file.path === SKILL_FILE)
    if (!entry)
      return { skillKey: source.skillKey, status: 'failed', message: `缺少 ${SKILL_FILE}` }

    const parsed = parseSkillMarkdown(entry.content, source.skillKey)
    if (!parsed.parsed) {
      return { skillKey: source.skillKey, status: 'failed', message: parsed.errors.join('；') }
    }
    const draft = parsed.parsed
    const skillKey = draft.skillKey
    const existing = await this.repository.find(skillKey)
    if (existing && !overwrite) {
      return { skillKey, status: 'skipped', message: '同名技能已存在（勾选「覆盖」可替换）' }
    }

    this.assertLimits(source.files)
    const notes =
      source.skipped.length > 0
        ? `已跳过 ${source.skipped.length} 个文件：${source.skipped.slice(0, 5).join('、')}`
        : null

    try {
      if (!existing) {
        const created = await this.repository.create(
          {
            skillKey,
            title: skillKey,
            description: draft.description,
            frontmatter: draft.frontmatter,
            enabled: true,
            source: SkillSource._source.Import.value,
            originUrl: source.originUrl,
            lastValidatedAt: new Date(),
            warnings: draft.warnings,
          },
          source.files,
        )
        await this.afterWrite(created)
        return { skillKey, status: 'created', message: notes }
      }

      await this.repository.transaction(async (manager) => {
        const version = await this.repository.bumpVersion(existing.id, undefined, manager)
        if (version === null) throw new SkillVersionConflictError(skillKey)
        await this.repository.update(
          existing.id,
          {
            title: skillKey,
            description: draft.description,
            frontmatter: draft.frontmatter,
            enabled: true,
            source: SkillSource._source.Import.value,
            originUrl: source.originUrl,
            warnings: draft.warnings,
            lastValidatedAt: new Date(),
          },
          manager,
        )
        await this.repository.replaceFiles(manager, existing.id, source.files)
      })
      await this.afterWrite(await this.requireSkill(skillKey))
      return { skillKey, status: 'updated', message: notes }
    } catch (error) {
      return { skillKey, status: 'failed', message: messageOf(error) }
    }
  }

  /** 写后收尾：更新统计 → 落盘（按启停）→ 清 loader 缓存 */
  private async afterWrite(entity: AiSkillEntity): Promise<void> {
    const files = await this.repository.filesOf(entity.id)
    await this.repository.update(entity.id, {
      contentHash: hashSkillFiles(files),
      fileCount: files.length,
    })

    if (!entity.enabled) {
      await this.materializer.remove(entity.skillKey)
      this.loader.reload()
      return
    }
    try {
      await this.materializer.sync({
        skillKey: entity.skillKey,
        files: files.map(toFileInput),
      })
      await this.repository.update(entity.id, { lastMaterializedAt: new Date() })
    } catch (error) {
      this.logger.error('ai.skill.materialize_failed', {
        skillKey: entity.skillKey,
        error: messageOf(error),
      })
      throw new SkillMaterializeFailedError(messageOf(error))
    } finally {
      this.loader.reload()
    }
  }

  private async requireSkill(skillKey: string): Promise<AiSkillEntity> {
    const entity = await this.repository.find(skillKey)
    if (!entity) throw new SkillNotFoundError(skillKey)
    return entity
  }

  /** 限额：文件数 / 单文件 / 总量（字符数；超出直接拒绝，不截断） */
  private assertLimits(files: readonly { path: string; content: string }[]): void {
    if (files.length > SKILL_MAX_FILES) {
      throw new SkillFileInvalidError(`文件数 ${files.length} 超过上限 ${SKILL_MAX_FILES}`)
    }
    for (const file of files) {
      if (file.content.length > SKILL_FILE_MAX_CHARS) {
        throw new SkillFileInvalidError(
          `${file.path} 内容 ${file.content.length} 字符，超过单文件上限 ${SKILL_FILE_MAX_CHARS}`,
        )
      }
    }
    const total = files.reduce((sum, file) => sum + file.content.length, 0)
    if (total > SKILL_TOTAL_MAX_CHARS) {
      throw new SkillFileInvalidError(
        `全部文件合计 ${total} 字符，超过上限 ${SKILL_TOTAL_MAX_CHARS}`,
      )
    }
  }
}

// ─────────────────────────── 工具函数 ───────────────────────────

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 名字归一化：不合法时翻译成业务错误（HTTP 层已过 schema，这里是绕过 HTTP 调 service 的兜底） */
const normalizeSkillOrThrow = (skillKey: string): string => {
  try {
    return normalizeSkillKey(skillKey)
  } catch (error) {
    throw new SkillInvalidError([messageOf(error)])
  }
}

/** 路径归一化：不合法时翻译成业务错误 */
const normalizeFilePathOrThrow = (path: string): string => {
  try {
    return normalizeSkillFilePath(path)
  } catch (error) {
    throw new SkillFileInvalidError(messageOf(error))
  }
}

const fileKind = (path: string): AiSkillFileModel['kind'] =>
  isMarkdownFile(path) ? SkillFileKind._source.Markdown.value : SkillFileKind._source.Code.value

/** 以技能 id 分组文件 */
const groupBySkill = (files: readonly AiSkillFileEntity[]): Map<string, AiSkillFileEntity[]> => {
  const map = new Map<string, AiSkillFileEntity[]>()
  for (const file of files) {
    const list = map.get(file.skillId) ?? []
    list.push(file)
    map.set(file.skillId, list)
  }
  return map
}

const toFileInput = (file: AiSkillFileEntity): { path: string; content: string } => ({
  path: file.path,
  content: file.content,
})

const toFileMeta = (file: AiSkillFileEntity): AiSkillFileModel => ({
  path: file.path,
  kind: fileKind(file.path),
  size: file.size,
  updatedAt: file.updatedAt,
})

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left ?? {}) === JSON.stringify(right ?? {})

const toModel = (entity: AiSkillEntity): AiSkillModel => ({
  id: entity.id,
  skillKey: entity.skillKey,
  title: entity.title || entity.skillKey,
  description: entity.description,
  frontmatter: entity.frontmatter ?? {},
  enabled: entity.enabled,
  source: entity.source as AiSkillModel['source'],
  originUrl: entity.originUrl,
  version: entity.version,
  fileCount: entity.fileCount,
  contentHash: entity.contentHash,
  lastMaterializedAt: entity.lastMaterializedAt,
  lastValidatedAt: entity.lastValidatedAt,
  warnings: entity.warnings ?? [],
  updatedBy: entity.updatedBy,
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
})
