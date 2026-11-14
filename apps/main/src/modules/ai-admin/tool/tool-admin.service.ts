import { Inject, Injectable } from '@nestjs/common'
import type { AiToolEntity } from '@repo/db'
import { AppLogger, WorkspaceRuntimeService, type PageQueryResult } from '@repo/kits'
import { ToolSource } from '@repo/shared'
import type {
  AiToolEventModel,
  AiToolLimits,
  AiToolListDto,
  AiToolModel,
  AiToolSecretField,
  AiToolUpdateDto,
  AiToolWorkspaceStatusModel,
} from '@repo/shared'
import type { ZodError } from 'zod'
import { hintOf } from '../../ai-model/secret-hint.js'
import {
  defaultsOf,
  findToolAdminSpec,
  mergeConfig,
  TOOL_ADMIN_SPECS,
  type ToolAdminSpec,
} from './tool-admin.catalog.js'
import { ToolConfigInvalidError, ToolNotRegisteredError } from './tool-admin.errors.js'
import {
  AI_TOOL_ADMIN_REPOSITORY,
  type AiToolAdminRepositoryPort,
} from './tool-admin.repository.js'

/**
 * 工具配置服务（`/ai-tool/*`，后台管理员）—— main 本地的控制面实现。
 *
 * 与旧 `modules/ai/api/ai-tool.service.ts` 同一套对外行为，但**不依赖 agent loop / Mastra /
 * 工具执行器**：
 * - **基础信息在代码、镜像入库**：`title` / `description` / `category` / `paramSchema` 由
 *   `@repo/tool-catalog` 的 manifest 提供；库里那行是启动期（或懒创建时）写下的镜像；
 * - **前端只配配置**：可改的只有开关 / 作用域 / 限额 / 配置值 / 秘钥；
 * - **合法性只有声明知道**：`config` / `secrets` 写入前一律过 `ToolAdminSpec` 的 schema；
 * - **秘钥明文入库、接口不回明文**：只回 `hintOf` 派生的 `secretFields[].hint`；
 * - **runtime 工具只读**：Mastra 自带的技能工具在列表里单列一组，`update` / `reset` 一律拒绝。
 */
@Injectable()
export class AiToolAdminService {
  constructor(
    @Inject(AI_TOOL_ADMIN_REPOSITORY)
    private readonly repository: AiToolAdminRepositoryPort,
    @Inject(WorkspaceRuntimeService) private readonly workspace: WorkspaceRuntimeService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * 当前部署的**执行环境能力**（只读）：管理页据此展示"沙箱是否可用 + 原因"，
   * 并决定切换为非沙箱时要不要提示"命令会被拒绝"。
   */
  async workspaceStatus(): Promise<AiToolWorkspaceStatusModel> {
    const status = await this.workspace.status()
    return {
      mode: status.mode,
      fileAccessOptions: status.fileAccessOptions,
      sandbox: {
        available: status.sandbox.available,
        ...(status.sandbox.impl ? { impl: status.sandbox.impl } : {}),
        ...(status.sandbox.reason
          ? { code: status.sandbox.reason.code, message: status.sandbox.reason.message }
          : {}),
      },
    }
  }

  /** 列表：代码声明（带配置）+ runtime 工具（只读），支持关键字 / 类别 / 开关 / 来源筛选 */
  async list(query: AiToolListDto): Promise<PageQueryResult<AiToolModel>> {
    const all = await this.snapshot()
    // runtime 工具不进库、也没有分页需求：一律附在最后，保证"工具清单与模型手上对得上账"
    const filtered = all.filter((tool) => {
      if (query.category !== undefined && tool.category !== query.category) return false
      if (query.enabled !== undefined && tool.enabled !== query.enabled) return false
      if (query.source !== undefined && tool.source !== query.source) return false
      if (query.keyword) {
        const keyword = query.keyword.toLowerCase()
        if (
          !tool.toolKey.toLowerCase().includes(keyword) &&
          !tool.title.toLowerCase().includes(keyword)
        ) {
          return false
        }
      }
      return true
    })
    const start = (query.page - 1) * query.size
    return {
      items: filtered.slice(start, start + query.size),
      total: filtered.length,
      page: query.page,
      size: query.size,
    }
  }

  /** 详情（缺失的配置行按代码声明合成，不产生写操作） */
  async detail(toolKey: string): Promise<AiToolModel> {
    const spec = findToolAdminSpec(toolKey)
    if (!spec) throw new ToolNotRegisteredError(toolKey)
    if (spec.runtime) return this.toModel(spec, null)
    const row = await this.repository.findByKey(toolKey)
    return this.toModel(spec, row)
  }

  /** 更新：config / secrets / limits / 开关 / 作用域（全部先校验） */
  async update(input: AiToolUpdateDto): Promise<AiToolModel> {
    const spec = this.requireEditable(input.toolKey)
    if (input.config) {
      const parsed = spec.config.safeParse({ ...defaultsOf(spec), ...input.config })
      if (!parsed.success) throw new ToolConfigInvalidError(formatIssues(parsed.error))
    }
    if (input.secrets && spec.secrets) {
      const parsed = spec.secrets.safeParse(input.secrets)
      if (!parsed.success) throw new ToolConfigInvalidError(formatIssues(parsed.error))
    }
    // main 侧不跑启动期种子：第一次写配置时懒创建那一行（基础信息按声明镜像写入）
    if (!(await this.repository.findByKey(input.toolKey))) {
      await this.repository.createSeed(spec)
    }
    await this.repository.update(input.toolKey, {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.allowedAgents !== undefined ? { allowedAgents: input.allowedAgents } : {}),
      ...(input.config !== undefined ? { config: input.config } : {}),
      ...(input.limits !== undefined ? { limits: input.limits as Record<string, unknown> } : {}),
      ...(input.secrets !== undefined ? { secrets: input.secrets } : {}),
    })
    this.logger.log('ai.tool.config_updated', {
      toolKey: input.toolKey,
      fields: Object.keys(input).filter((key) => key !== 'toolKey'),
    })
    return this.detail(input.toolKey)
  }

  /** 恢复默认：清掉人工覆盖（秘钥一并清空），来源回 `seed` */
  async reset(toolKey: string): Promise<AiToolModel> {
    const spec = this.requireEditable(toolKey)
    if (!(await this.repository.findByKey(toolKey))) {
      await this.repository.createSeed(spec)
    }
    await this.repository.reset(toolKey, { scope: spec.scope, config: defaultsOf(spec) })
    this.logger.warn('ai.tool.config_reset', { toolKey })
    return this.detail(toolKey)
  }

  /** 快照：代码声明 + runtime 工具（只读），用库里的配置行覆盖可变部分 */
  private async snapshot(): Promise<AiToolModel[]> {
    const rows = await this.repository.listAll()
    const byKey = new Map(rows.map((row) => [row.toolKey, row]))
    return TOOL_ADMIN_SPECS.map((spec) =>
      this.toModel(spec, spec.runtime ? null : (byKey.get(spec.key) ?? null)),
    )
  }

  private requireEditable(toolKey: string): ToolAdminSpec {
    const spec = findToolAdminSpec(toolKey)
    // runtime 自带工具在代码清单里，但不可编辑 —— 与旧实现一样按 3407 拒绝
    if (!spec || !spec.editable) throw new ToolNotRegisteredError(toolKey)
    return spec
  }

  private toModel(spec: ToolAdminSpec, row: AiToolEntity | null): AiToolModel {
    const defaults = defaultsOf(spec)
    const secretFields: AiToolSecretField[] = spec.secretFields.map((field) => ({
      name: field.name,
      label: field.label,
      required: field.required ?? false,
      // 只回提示串：明文永远不离开数据库
      hint: row?.secrets?.[field.name] ? hintOf(row.secrets[field.name]) : null,
    }))
    return {
      toolKey: spec.key,
      // 基础信息取库里的镜像；老行 / 没种子时回落到代码声明
      title: row?.title?.trim() ? row.title.trim() : spec.title,
      description: row?.description?.trim() ? row.description.trim() : spec.description,
      category: spec.category,
      enabled: row?.enabled ?? true,
      scope: row?.scope ?? spec.scope,
      allowedAgents: [...(row?.allowedAgents ?? [])],
      // main 不持有 agent 声明（在 agent-runtime 侧），这里如实给空数组
      agents: [],
      config: mergeConfig(spec, row?.config ?? null),
      defaultConfig: defaults,
      secretFields,
      limits: (row?.limits ?? {}) as AiToolLimits,
      source: row?.source ?? ToolSource._source.Seed.value,
      paramSchema: row?.paramSchema ?? spec.paramSchema,
      events: (row?.events ?? []) as AiToolEventModel[],
      pageBytes: spec.pageBytes,
      editable: spec.editable,
      lastSeenAt: row?.lastSeenAt ?? undefined,
      updatedBy: row?.updatedBy ?? null,
      createdAt: row?.createdAt,
      updatedAt: row?.updatedAt,
    }
  }
}

/** zod 校验失败 → 可直接展示的中文原因（带字段路径） */
const formatIssues = (error: ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`).join('；')
