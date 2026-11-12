import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, WorkspaceRuntimeService, type PageQueryResult } from '@repo/kits'
import { ToolCategory } from '@repo/shared'
import type {
  AiToolListDto,
  AiToolModel,
  AiToolUpdateDto,
  AiToolWorkspaceStatusModel,
} from '@repo/shared'
import type { AgentRegistry } from '../agents/types.js'
import { AGENT_REGISTRY } from '../agents/registry.js'
import { RUNTIME_TOOLS } from '../core/tools/tool-keys.js'
import { ToolConfigRepository } from '../core/tools/tool.config.repository.js'
import { TOOL_ENV_CAPS } from '../core/tools/tool.config.ports.js'
import { ToolConfigInvalidError, ToolNotRegisteredError } from '../core/tools/tool.errors.js'
import { toAiToolEventModels } from '../core/tools/tool-event.js'
import { toJsonSchema } from '../core/tools/tool.schema.js'
import { codeDefaults } from '../core/tools/tool.settings.js'
import { ToolConfigService } from '../core/tools/tool.config.service.js'
import { ToolRegistry } from '../core/tools/tool.registry.js'
import type { AiToolSecretField } from '@repo/shared'
import type { AnyToolSpec, ToolSettings } from '../core/tools/tools.types.js'

/**
 * 工具配置服务（`/ai-tool/*`，后台管理员）—— 设计 §5.5 / §5.11。
 *
 * 四条口径：
 * - **基础信息在代码、镜像入库**：`title` / `description` / `category` / `paramSchema` 由启动期的
 *   种子同步全量写入，这里只读（**不提供编辑入口**）；
 * - **前端只配配置**：可改的只有开关 / 作用域 / 限额 / 配置值 / 秘钥；
 * - **合法性只有声明知道**：`config` / `secrets` / `limits` 写入前一律过 `spec` 的 schema；
 * - **秘钥明文入库、接口不回明文**：只回 `hintOf` 派生的 `secretFields[].hint`；
 * - **runtime 工具只读**：Mastra 自带的技能工具在列表里单列一组，`update` / `reset` 一律拒绝。
 */
@Injectable()
export class AiToolService {
  constructor(
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(ToolConfigRepository) private readonly repository: ToolConfigRepository,
    @Inject(AGENT_REGISTRY) private readonly agents: AgentRegistry,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(ToolConfigService) private readonly toolConfig: ToolConfigService,
    @Inject(WorkspaceRuntimeService) private readonly workspace: WorkspaceRuntimeService,
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

  /** 列表：注册工具（带配置）+ runtime 工具（只读），支持关键字 / 类别 / 开关 / 来源筛选 */
  async list(query: AiToolListDto): Promise<PageQueryResult<AiToolModel>> {
    const all = await this.snapshot()
    // runtime 工具不进库、也没有分页需求：一律附在最后一页之后，保证"工具清单与模型手上对得上账"
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

  /** 详情 */
  async detail(toolKey: string): Promise<AiToolModel> {
    const all = await this.snapshot()
    const found = all.find((tool) => tool.toolKey === toolKey)
    if (!found) throw new ToolNotRegisteredError(toolKey)
    return found
  }

  /** 更新：config / secrets / limits / 开关 / 作用域 / 文案（全部先校验） */
  async update(input: AiToolUpdateDto): Promise<AiToolModel> {
    const spec = this.requireSpec(input.toolKey)
    if (input.config) {
      const parsed = spec.config.safeParse({ ...codeDefaults(spec), ...input.config })
      if (!parsed.success) {
        throw new ToolConfigInvalidError(
          parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
            .join('；'),
        )
      }
    }
    if (input.secrets && spec.secrets) {
      const parsed = spec.secrets.safeParse(input.secrets)
      if (!parsed.success) {
        throw new ToolConfigInvalidError(
          parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
            .join('；'),
        )
      }
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
    // 同进程立即生效：配置缓存 5 秒是为了每次调用不查库，保存后要主动失效；
    // 多实例下别的实例仍最多晚 5 秒（如实记录，不假装强一致）
    this.toolConfig.invalidate(input.toolKey)
    return this.detail(input.toolKey)
  }

  /** 恢复默认：清掉人工覆盖（秘钥一并清空），来源回 `seed` */
  async reset(toolKey: string): Promise<AiToolModel> {
    const spec = this.requireSpec(toolKey)
    await this.repository.reset(spec)
    this.logger.warn('ai.tool.config_reset', { toolKey })
    this.toolConfig.invalidate(toolKey)
    return this.detail(toolKey)
  }

  /**
   * 快照：注册工具的配置 + runtime 工具（只读）。
   *
   * 每个工具带上"哪些 agent 授权了它"—— 这份数据在 agent 声明里，DB 没有，
   * 所以在这里从 agent 注册表算出来。
   */
  async snapshot(): Promise<AiToolModel[]> {
    const rows = await Promise.all(
      this.registry.specs().map(async (spec) => {
        const settings = await this.registry.settings(spec.key)
        return this.toModel(spec, settings, this.agentsOf(spec.key))
      }),
    )
    const runtime: AiToolModel[] = RUNTIME_TOOLS.map((tool) => ({
      toolKey: tool.key,
      title: tool.title,
      description: tool.description,
      category: ToolCategory._source.Runtime.value,
      enabled: true,
      scope: 'all',
      allowedAgents: [],
      agents: [],
      config: {},
      defaultConfig: {},
      secretFields: [],
      limits: {},
      source: 'seed',
      paramSchema: null,
      events: [],
      pageBytes: null,
      editable: false,
      updatedBy: null,
    }))
    return [...rows, ...runtime]
  }

  /** 快照里某个工具的配置行（数据访问层要它做种子 / 重置） */
  async requireSettings(toolKey: string): Promise<ToolSettings> {
    this.requireSpec(toolKey)
    return this.registry.settings(toolKey)
  }

  private requireSpec(toolKey: string): AnyToolSpec {
    const spec = this.registry.get(toolKey)
    if (!spec) throw new ToolNotRegisteredError(toolKey)
    return spec.spec
  }

  /** 哪些 agent 的声明里含这个工具（提示词与实际授权同源，见 `agents/index.ts`） */
  private agentsOf(toolKey: string): string[] {
    return this.agents
      .all()
      .filter((definition) => definition.tools.includes(toolKey))
      .map((definition) => definition.key)
  }

  private toModel(spec: AnyToolSpec, settings: ToolSettings, agents: string[]): AiToolModel {
    const defaults = codeDefaults(spec) as Record<string, unknown>
    // 连接器产出的工具：密钥归连接器实例管（在这儿展示只会让人以为要重复填一遍）
    const secretFields: AiToolSecretField[] = (spec.connector ? [] : spec.secretFields ?? []).map((field) => ({
      name: field.name,
      label: field.label,
      required: field.required ?? false,
      hint: settings.secretHint(field.name),
    }))
    return {
      toolKey: spec.key,
      // 基础信息直接给库里的值（启动期由种子从代码声明全量写入的镜像）
      title: settings.title,
      description: settings.description,
      category: spec.category,
      enabled: settings.enabled,
      scope: settings.scope,
      allowedAgents: [...settings.allowedAgents],
      agents,
      config: settings.config as Record<string, unknown>,
      defaultConfig: defaults,
      secretFields,
      limits: settings.limits,
      source: settings.source,
      // 参数定义同样取库里的镜像（启动期写入）；老行缺列时现算一次兜底
      paramSchema: settings.paramSchema ?? toJsonSchema(spec),
      // 自定义事件声明同属"基础信息镜像"：库里那份与代码声明同源（见 §5.17），老行现算兜底
      events: [...(settings.events ?? toAiToolEventModels(spec.events))],
      pageBytes: spec.paginate?.pageBytes ?? null,
      editable: true,
      updatedBy: null,
    }
  }
}
