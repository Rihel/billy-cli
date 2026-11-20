import { Inject, Injectable, Optional } from '@nestjs/common'
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
import type { AiSkillEntity, AiSkillFileEntity } from '@repo/db'
import {
  hashSkillFiles,
  isMarkdownFile,
  normalizeSkillFilePath,
  normalizeSkillKey,
  parseSkillMarkdown,
  SKILL_FILE,
  validateSkillDraft,
  type SkillDraft,
} from './skill.rules.js'
import {
  SkillFileInvalidError,
  SkillImportFailedError,
  SkillInvalidError,
  SkillKeyConflictError,
  SkillNotFoundError,
  SkillQuotaExceededError,
  SkillVersionConflictError,
} from './skill.errors.js'
import { fetchRemoteSkillSources, type RemoteSkillSource } from './skill.remote.js'
import { SkillRepository } from './skill.repository.js'

/** 个人技能数量上限（§6.7.5） */
const PERSONAL_SKILL_QUOTA = 50
import { currentSkillCaller, resolveSkillWriteTarget } from './skill-scope.js'
import { SkillSyncService } from './skill-sync.service.js'
import {
  SKILL_CHANGE_NOTIFIER,
  type SkillChangeEvent,
  type SkillChangeNotifier,
} from './skill.ports.js'

/**
 * 技能管理服务（main 是唯一的 HTTP/CRUD 服务）。
 *
 * 与 agent-runtime 时代相比，数据与校验语义不变，**只是不再落盘、不再碰 Mastra**：
 * - **DB 是事实源**：所有写操作先提交事务，再发 Redis 事件通知 runtime 刷新目录；
 * - **`SKILL.md` 由「description + frontmatter + 正文」拼出来**：页面 / 工具 / 导入三条入口
 *   都走同一个 `validateSkillDraft`（本模块的纯函数），不会出现「页面存得进、runtime 加载不了」；
 * - **乐观锁**：保存带 `expectedVersion`，条件更新失败就 3417，绝不静默覆盖别人的改动；
 * - **停用 = 标记 + 通知删目录**：runtime 收到 `remove` 事件后会删掉落盘目录；
 * - **通知是 at-most-once**：Redis 不可用时只记日志，接口仍按「已入库」返回；
 *   runtime 启动时全量同步兜底（不把广播当可靠队列用）。
 */
@Injectable()
export class SkillAdminService {
  constructor(
    @Inject(SkillRepository) private readonly repository: SkillRepository,
    @Inject(SKILL_CHANGE_NOTIFIER) private readonly notifier: SkillChangeNotifier,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Optional() @Inject(SkillSyncService) private readonly skillSync?: SkillSyncService,
  ) {}

  /** 列表 */
  async list(query: AiSkillListDto): Promise<PageQueryResult<AiSkillModel>> {
    const page = await this.repository.page(query, currentSkillCaller())
    return { ...page, items: page.items.map((entity) => toModel(entity)) }
  }

  /** 详情：元信息 + 文件清单（正文由 `readFile` 单独取） */
  async detail(skillKey: string): Promise<AiSkillDetailModel> {
    const entity = await this.requireSkill(skillKey)
    const files = await this.repository.filesOf(entity.id)
    return { ...toModel(entity), files: files.map(toFileMeta) }
  }

  /** 新建（在线创建；建完默认启用，通知 runtime 落盘） */
  async create(input: AiSkillCreateDto): Promise<AiSkillDetailModel> {
    const skillKey = normalizeSkillOrThrow(input.skillKey)
    const target = resolveSkillWriteTarget(currentSkillCaller(), input.scope)
    // 个人技能配额（§6.7.5）：避免单人的技能目录无限膨胀、挤占上下文
    if (target.scope === 'personal' && target.ownerType && target.ownerId) {
      const owned = await this.repository.countPersonal({
        ownerType: target.ownerType,
        ownerId: target.ownerId,
      })
      if (owned >= PERSONAL_SKILL_QUOTA) throw new SkillQuotaExceededError(PERSONAL_SKILL_QUOTA)
    }
    // 冲突只看同一 scope + owner：个人技能可以与平台同名（个人优先覆盖）
    if (await this.repository.existsInScope(skillKey, target))
      throw new SkillKeyConflictError(skillKey)

    const draft: SkillDraft = {
      skillKey,
      description: input.description?.trim() || SKILL_DESCRIPTION_PLACEHOLDER,
      frontmatter: input.frontmatter ?? {},
      body: input.body ?? '',
    }
    const validation = validateSkillDraft(draft)
    if (!validation.valid) throw new SkillInvalidError(validation.errors)

    const extraFiles = (input.files ?? []).map((file) => {
      const path = normalizeFilePathOrThrow(file.path)
      if (path === SKILL_FILE) {
        throw new SkillFileInvalidError(`${SKILL_FILE} 由技能描述与正文生成，不要在 files 里传`)
      }
      return { path, content: file.content }
    })
    const files = [{ path: SKILL_FILE, content: validation.content }, ...extraFiles]
    this.assertLimits(files)

    const entity = await this.repository.create(
      {
        skillKey,
        title: input.title ?? skillKey,
        description: draft.description,
        frontmatter: draft.frontmatter,
        enabled: input.enabled ?? true,
        source: SkillSource._source.Online.value,
        // 写入目标由身份决定，入参里的 scope 不参与（D12）
        scope: target.scope,
        ownerType: target.ownerType,
        ownerId: target.ownerId,
        lastValidatedAt: new Date(),
        warnings: validation.warnings,
      },
      files,
    )

    this.logger.log('ai.skill.created', { skillKey, files: files.length, enabled: entity.enabled })
    await this.afterWrite(entity, 'create')
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
    await this.afterWrite(await this.requireSkill(entity.skillKey), 'update')
    return this.detail(entity.skillKey)
  }

  /** 软删技能；通知 runtime 删掉落盘目录 */
  async remove(skillKey: string): Promise<{ ok: boolean }> {
    const entity = await this.requireSkill(skillKey)
    await this.repository.softRemove(entity.id)
    // 按**技能归属**推工作区：平台技能（god 维护）影响全部；个人技能只影响 owner 自己的工作区
    // （AI 通过 skill-save 写进来的技能同样落成个人技能，owner 就是当时操作的账号）
    try {
      await this.skillSync?.push(
        entity.scope === 'platform'
          ? [{ principalType: 'all', principalId: '*' }]
          : [
              {
                principalType: (entity.ownerType === 'user' ? 'user' : 'admin') as 'user' | 'admin',
                principalId: entity.ownerId ?? '',
              },
            ],
      )
    } catch (error) {
      this.logger.warn('skill.sync_push_failed', {
        skillKey: entity.skillKey,
        reason: String(error),
      })
    }

    await this.notify({
      skillKey: entity.skillKey,
      action: 'remove',
      version: entity.version,
      enabled: false,
      reason: 'remove',
      at: Date.now(),
    })
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
    await this.afterWrite(await this.requireSkill(entity.skillKey), 'file-save')
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
    await this.afterWrite(await this.requireSkill(entity.skillKey), 'file-remove')
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
    const target = resolveSkillWriteTarget(currentSkillCaller(), input.scope)
    const fetched = await this.fetchOrThrow(input.url)
    const selected = input.skillKeys?.length
      ? fetched.sources.filter((source) => input.skillKeys!.includes(source.skillKey))
      : fetched.sources
    if (selected.length === 0 && fetched.failures.length === 0) {
      throw new SkillImportFailedError('没有匹配的技能（勾选的技能名不在这个链接里）')
    }

    const items: AiSkillImportItemModel[] = []
    for (const source of selected) {
      items.push(await this.importOne(source, input.overwrite ?? false, target))
    }
    // 扫描阶段就失败的目录也要如实报告（否则用户以为「都导进来了」）
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
   * 预览与导入各自下载一次（技能仓库不大；换来的好处是不用维护「预取缓存」的生命周期）。
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

  /** 下载 + 把「连来源都解析不了 / 整包下载失败」翻译成业务错误 */
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
    target: {
      scope: 'platform' | 'personal'
      ownerType: 'user' | 'admin' | null
      ownerId: string | null
    },
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
            scope: target.scope,
            ownerType: target.ownerType,
            ownerId: target.ownerId,
            source: SkillSource._source.Import.value,
            originUrl: source.originUrl,
            lastValidatedAt: new Date(),
            warnings: draft.warnings,
          },
          source.files,
        )
        await this.afterWrite(created, 'import-create')
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
            scope: target.scope,
            ownerType: target.ownerType,
            ownerId: target.ownerId,
            source: SkillSource._source.Import.value,
            originUrl: source.originUrl,
            warnings: draft.warnings,
            lastValidatedAt: new Date(),
          },
          manager,
        )
        await this.repository.replaceFiles(manager, existing.id, source.files)
      })
      await this.afterWrite(await this.requireSkill(skillKey), 'import-update')
      return { skillKey, status: 'updated', message: notes }
    } catch (error) {
      return { skillKey, status: 'failed', message: messageOf(error) }
    }
  }

  /**
   * 写后收尾：更新统计 → 通知 runtime（落盘 / 删目录）。
   *
   * main 不直接落盘：runtime 收到事件后从 DB 读全量文件并刷新目录。
   * 通知失败不回滚、不抛错（DB 已提交；runtime 启动自愈兜底）。
   */
  private async afterWrite(
    entity: AiSkillEntity,
    reason: SkillChangeEvent['reason'],
  ): Promise<void> {
    const files = await this.repository.filesOf(entity.id)
    await this.repository.update(entity.id, {
      contentHash: hashSkillFiles(files),
      fileCount: files.length,
    })

    // 按**技能归属**推工作区：平台技能（god 维护）影响全部；个人技能只影响 owner 自己的工作区
    // （AI 通过 skill-save 写进来的技能同样落成个人技能，owner 就是当时操作的账号）
    try {
      await this.skillSync?.push(
        entity.scope === 'platform'
          ? [{ principalType: 'all', principalId: '*' }]
          : [
              {
                principalType: (entity.ownerType === 'user' ? 'user' : 'admin') as 'user' | 'admin',
                principalId: entity.ownerId ?? '',
              },
            ],
      )
    } catch (error) {
      this.logger.warn('skill.sync_push_failed', {
        skillKey: entity.skillKey,
        reason: String(error),
      })
    }

    await this.notify({
      skillKey: entity.skillKey,
      action: entity.enabled ? 'upsert' : 'remove',
      version: entity.version,
      enabled: entity.enabled,
      reason,
      at: Date.now(),
    })
  }

  private async notify(event: SkillChangeEvent): Promise<void> {
    try {
      const published = await this.notifier.notify(event)
      this.logger.log('ai.skill.change_notified', {
        skillKey: event.skillKey,
        action: event.action,
        reason: event.reason,
        published,
      })
    } catch (error) {
      // 端口实现自身抛错也不能让「DB 已提交」的接口失败
      this.logger.error('ai.skill.change_notify_failed', {
        skillKey: event.skillKey,
        action: event.action,
        reason: event.reason,
        error: messageOf(error),
      })
    }
  }

  private async requireSkill(skillKey: string): Promise<AiSkillEntity> {
    const entity = await this.repository.findVisible(skillKey, currentSkillCaller())
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
