import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, Db, pageWith, type PageQueryResult } from '@repo/kits'
import { ToolSource, type AiToolListDto } from '@repo/shared'
import type { DeepPartial } from 'typeorm'
import { AiToolEntity } from '../../../../database/entities/ai-tool-entity.js'
import { toAiToolEventModels } from './tool-event.js'
import { toJsonSchema } from './tool.schema.js'
import type { ToolConfigRow, ToolConfigSource } from './tool.config.ports.js'
import { codeDefaults } from './tool.settings.js'
import type { AnyToolSpec } from './tools.types.js'

/**
 * 工具配置的**数据访问层**（设计 §5.5）。
 *
 * 三件事：读写 `ai_tools`、把实体翻译成 `ToolConfigRow`、**启动期全量写入 DSL 镜像**。
 *
 * 三条硬口径：
 * - **秘钥明文入库**（2026-10-01 决定）：提示串在读取时由 `hintOf` 派生；
 * - **基础信息是代码声明的镜像**：`title` / `description` / `category` / `param_schema`
 *   每次启动**全量覆盖**写（代码是唯一事实源），前端只读；
 * - **配置值允许稀疏**：库里只存改过的字段，合并交给纯函数（`mergeToolSettings`）——
 *   于是"合并规则"可以脱离数据库单测。
 */

@Injectable()
export class ToolConfigRepository implements ToolConfigSource {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  private async repo() {
    return this.db.getRepository(AiToolEntity)
  }

  /** 读一行（软删自动排除） */
  async findByKey(toolKey: string): Promise<AiToolEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ toolKey })
  }

  /** `ToolConfigSource`：给注册机提供生效配置的原料（含解密后的秘钥） */
  async load(spec: AnyToolSpec): Promise<ToolConfigRow | null> {
    const row = await this.findByKey(spec.key)
    if (!row) return null
    return {
      enabled: row.enabled,
      scope: row.scope,
      allowedAgents: row.allowedAgents,
      config: row.config,
      limits: row.limits,
      title: row.title,
      description: row.description,
      paramSchema: row.paramSchema,
      events: row.events,
      source: row.source,
      version: (row.updatedAt ?? row.createdAt ?? new Date()).toISOString(),
      secrets: row.secrets ?? {},
    }
  }

  /** 分页列表（后台页用；按创建时间倒序 + 更新时间为辅，保证顺序稳定） */
  async page(query: AiToolListDto): Promise<PageQueryResult<AiToolEntity>> {
    const repo = await this.repo()
    const builder = repo
      .createQueryBuilder('t')
      .orderBy('t.created_at', 'DESC')
      .addOrderBy('t.id', 'DESC')
    if (query.keyword) {
      builder.andWhere('(t.tool_key ILIKE :keyword OR t.title ILIKE :keyword)', {
        keyword: `%${query.keyword}%`,
      })
    }
    if (query.category !== undefined) builder.andWhere('t.category = :category', { category: query.category })
    if (query.enabled !== undefined) builder.andWhere('t.enabled = :enabled', { enabled: query.enabled })
    if (query.source !== undefined) builder.andWhere('t.source = :source', { source: query.source })
    const { data, total } = await pageWith(builder, query.page, query.size)
    return { items: data, total, page: query.page, size: query.size }
  }

  /**
   * 种子同步（幂等，**每次启动全量写 DSL 镜像**）。
   *
   * 分两类字段，处理方式不同（这是"前端只配配置、基础信息留在代码"的落点）：
   *
   * | 字段 | 来源 | 每次启动 |
   * | --- | --- | --- |
   * | `title` / `description` / `category` / `param_schema` | **代码声明** | **全量覆盖写**（代码是唯一事实源） |
   * | `enabled` / `scope` / `allowed_agents` / `limits` / `config` / `secrets` | 人的决定 | **不动**（只在新建时给默认值；缺的配置键用默认补齐） |
   *
   * `source` 只描述"配置有没有被人改过"：`manual` 时连"缺键补齐"都跳过（人可能故意删掉某个键）。
   */
  async upsertSeed(spec: AnyToolSpec): Promise<'created' | 'updated' | 'seen'> {
    const repo = await this.repo()
    const existing = await this.findByKey(spec.key)
    const defaults = codeDefaults(spec) as Record<string, unknown>
    const now = new Date()
    // 基础信息（DSL 镜像）：每次启动都按代码声明覆盖
    const base = {
      title: spec.title,
      description: spec.description,
      category: spec.category,
      paramSchema: toJsonSchema(spec),
      // 事件声明同属基础信息：每次启动全量覆盖（库里那份是只读镜像，见设计 §5.17）
      events: toAiToolEventModels(spec.events),
    }
    if (!existing) {
      await repo.save(
        repo.create({
          toolKey: spec.key,
          ...base,
          config: defaults,
          scope: spec.scope,
          enabled: true,
          source: ToolSource._source.Seed.value,
          lastSeenAt: now,
        } as DeepPartial<AiToolEntity>),
      )
      return 'created'
    }
    if (existing.source === ToolSource._source.Manual.value) {
      // 配置归人：只刷基础信息与"最近见到"的时间
      await repo.update({ id: existing.id }, { ...base, lastSeenAt: now } as never)
      return 'seen'
    }
    await repo.update(
      { id: existing.id },
      {
        ...base,
        // 缺的键用当前默认值补齐；已存的值优先（人改过的值在 source=manual，走不到这里）
        config: { ...defaults, ...(existing.config ?? {}) },
        lastSeenAt: now,
      } as never,
    )
    return 'updated'
  }

  /** 更新（后台页调用；秘钥单独处理） */
  async update(
    toolKey: string,
    changes: {
      enabled?: boolean
      scope?: string
      allowedAgents?: string[]
      config?: Record<string, unknown>
      limits?: Record<string, unknown>
      secrets?: Record<string, string>
    },
  ): Promise<AiToolEntity> {
    const repo = await this.repo()
    const existing = await this.findByKey(toolKey)
    if (!existing) throw new Error(`工具配置不存在：${toolKey}`)
    const patch: DeepPartial<AiToolEntity> = { source: ToolSource._source.Manual.value }
    if (changes.enabled !== undefined) patch.enabled = changes.enabled
    if (changes.scope !== undefined) patch.scope = changes.scope
    if (changes.allowedAgents !== undefined) patch.allowedAgents = changes.allowedAgents
    if (changes.config !== undefined) patch.config = changes.config
    if (changes.limits !== undefined) patch.limits = changes.limits
    // 秘钥：省略 = 不改；空串 = 清空；给值 = 覆盖（**明文入库**）
    const secrets = { ...(existing.secrets ?? {}) }
    let secretChanged = false
    for (const [name, value] of Object.entries(changes.secrets ?? {})) {
      secretChanged = true
      if (value === '') {
        delete secrets[name]
        continue
      }
      secrets[name] = value
    }
    if (secretChanged) patch.secrets = Object.keys(secrets).length > 0 ? secrets : null
    // jsonb 字段的 DeepPartial 类型在 TypeORM 里不认 `Record<string, unknown>`（值类型太宽），
    // 这里显式收窄 —— 校验已在 service 层做过
    await repo.update({ id: existing.id }, patch as never)
    const updated = await this.findByKey(toolKey)
    if (!updated) throw new Error(`工具配置更新后读回失败：${toolKey}`)
    return updated
  }

  /** 恢复默认：清掉人工覆盖（配置值回到代码默认，秘钥清空，来源回 `seed`） */
  async reset(spec: AnyToolSpec): Promise<AiToolEntity> {
    const repo = await this.repo()
    const existing = await this.findByKey(spec.key)
    if (!existing) throw new Error(`工具配置不存在：${spec.key}`)
    await repo.update(
      { id: existing.id },
      {
        enabled: true,
        scope: spec.scope,
        allowedAgents: null,
        config: codeDefaults(spec) as Record<string, unknown>,
        limits: null,
        secrets: null,
        source: ToolSource._source.Seed.value,
        lastSeenAt: new Date(),
      } as never,
    )
    const updated = await this.findByKey(spec.key)
    if (!updated) throw new Error(`工具配置重置后读回失败：${spec.key}`)
    return updated
  }

}
