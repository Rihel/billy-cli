import { Inject, Injectable } from '@nestjs/common'
import { AiToolEntity } from '@repo/db'
import { Db } from '@repo/kits'
import { ToolSource } from '@repo/shared'
import type { DeepPartial } from 'typeorm'
import { defaultsOf, type ToolAdminSpec } from './tool-admin.catalog.js'

/**
 * 工具配置的**数据访问层**（表：`ai_tools`）。
 *
 * 三件事：读写 `ai_tools`、把"代码声明的镜像"落库、给 service 一个可替换的端口。
 *
 * 三条硬口径（与旧 `modules/ai` 的实现一致）：
 * - **秘钥明文入库**（工程取舍，2026-10-01 定）：提示串在读取时从明文派生，接口不回明文；
 * - **基础信息是代码声明的镜像**：`title` / `description` / `category` / `param_schema`
 *   在懒创建时按 manifest 写入（main 控制面不依赖启动期种子也能自洽）；
 * - **配置值允许稀疏**：库里只存改过的字段，合并成完整配置由 `mergeConfig` 做。
 *
 * 用端口（`AI_TOOL_ADMIN_REPOSITORY`）而不是直接依赖类：service 的单测可以给 fake repo，
 * 不必连数据库。
 */

/** 后台更新要写的可变字段（省略 = 不改） */
export interface AiToolAdminUpdatePatch {
  enabled?: boolean
  scope?: string
  allowedAgents?: string[]
  config?: Record<string, unknown>
  limits?: Record<string, unknown>
  /** 秘钥：省略 = 不改，空串 = 清空该字段，给值 = 覆盖 */
  secrets?: Record<string, string>
}

/** 恢复默认要写的值（代码默认值由 service 从声明算好） */
export interface AiToolAdminResetValues {
  scope: string
  config: Record<string, unknown>
}

/** 数据访问端口（service 只依赖它；测试给内存实现） */
export interface AiToolAdminRepositoryPort {
  /** 全量配置行（软删自动排除；列表按代码声明顺序重排，不依赖这里的顺序） */
  listAll(): Promise<AiToolEntity[]>
  findByKey(toolKey: string): Promise<AiToolEntity | null>
  /** 懒创建：main 侧没有启动期种子时，第一次写配置也要有一行 */
  createSeed(spec: ToolAdminSpec): Promise<AiToolEntity>
  update(toolKey: string, patch: AiToolAdminUpdatePatch): Promise<AiToolEntity>
  reset(toolKey: string, values: AiToolAdminResetValues): Promise<AiToolEntity>
}

/** 注入 token（Nest 用 `useExisting` 指向真实仓储） */
export const AI_TOOL_ADMIN_REPOSITORY = Symbol.for('AiToolAdminRepository')

@Injectable()
export class AiToolAdminRepository implements AiToolAdminRepositoryPort {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(AiToolEntity)
  }

  async listAll(): Promise<AiToolEntity[]> {
    const repo = await this.repo()
    return repo.find()
  }

  async findByKey(toolKey: string): Promise<AiToolEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ toolKey })
  }

  /**
   * 懒创建一行：基础信息按代码声明写（镜像），配置写完整默认值，来源 `seed`。
   *
   * 只在第一次执行 `update` / `reset` 时调用；`detail` / `list` 对缺失的行直接按声明
   * 合成模型，不产生写操作。
   */
  async createSeed(spec: ToolAdminSpec): Promise<AiToolEntity> {
    const repo = await this.repo()
    return repo.save(
      repo.create({
        toolKey: spec.key,
        title: spec.title,
        description: spec.description,
        category: spec.category,
        paramSchema: spec.paramSchema,
        events: [],
        config: defaultsOf(spec),
        scope: spec.scope,
        enabled: true,
        source: ToolSource._source.Seed.value,
        lastSeenAt: new Date(),
      } as DeepPartial<AiToolEntity>),
    )
  }

  async update(toolKey: string, patch: AiToolAdminUpdatePatch): Promise<AiToolEntity> {
    const repo = await this.repo()
    const existing = await this.findByKey(toolKey)
    if (!existing) throw new Error(`工具配置不存在：${toolKey}`)

    const changes: DeepPartial<AiToolEntity> = { source: ToolSource._source.Manual.value }
    if (patch.enabled !== undefined) changes.enabled = patch.enabled
    if (patch.scope !== undefined) changes.scope = patch.scope
    if (patch.allowedAgents !== undefined) changes.allowedAgents = patch.allowedAgents
    if (patch.config !== undefined) changes.config = patch.config
    if (patch.limits !== undefined) changes.limits = patch.limits

    // 秘钥：与已有值合并（省略的字段保留；空串删除）
    const secrets = { ...existing.secrets }
    let secretChanged = false
    for (const [name, value] of Object.entries(patch.secrets ?? {})) {
      secretChanged = true
      if (value === '') {
        delete secrets[name]
        continue
      }
      secrets[name] = value
    }
    if (secretChanged) changes.secrets = Object.keys(secrets).length > 0 ? secrets : null

    // jsonb 字段的 DeepPartial 类型在 TypeORM 里不认 `Record<string, unknown>`（值类型太宽），
    // 这里显式收窄 —— 校验已在 service 层做过
    await repo.update({ id: existing.id }, changes as never)
    const updated = await this.findByKey(toolKey)
    if (!updated) throw new Error(`工具配置更新后读回失败：${toolKey}`)
    return updated
  }

  /** 恢复默认：清掉人工覆盖（配置回代码默认、秘钥清空、来源回 `seed`） */
  async reset(toolKey: string, values: AiToolAdminResetValues): Promise<AiToolEntity> {
    const repo = await this.repo()
    const existing = await this.findByKey(toolKey)
    if (!existing) throw new Error(`工具配置不存在：${toolKey}`)
    await repo.update({ id: existing.id }, {
      enabled: true,
      scope: values.scope,
      allowedAgents: null,
      config: values.config,
      limits: null,
      secrets: null,
      source: ToolSource._source.Seed.value,
      lastSeenAt: new Date(),
    } as never)
    const updated = await this.findByKey(toolKey)
    if (!updated) throw new Error(`工具配置重置后读回失败：${toolKey}`)
    return updated
  }
}
