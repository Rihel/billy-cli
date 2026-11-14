import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { ConnectorStatus } from '@repo/shared'
import type { AiConnectorActionResult } from '@repo/shared'
import { ToolRegistry } from '../core/tools/tool.registry.js'
import { CONNECTOR_DRIVERS } from './connector.types.js'
import type { ConnectorDriverMap } from './connector.types.js'
import { ConnectorRepository } from './connector.repository.js'
import { ConnectorService } from './connector.service.js'
import { toConnectorToolSpec, type ToolCapability } from './connector.tool.factory.js'

/**
 * 连接器同步（设计 `docs/design/ai-connector.md` §3.6）。
 *
 * 一次同步 = 连一次 → 列能力 → 转成工具 → 写 `ai_tools` → 注册进注册机。
 * 它**不**碰提示词、不重建 agent：Mastra 的工具面是按请求解析的（§3.5）。
 *
 * 失败口径：摘掉这家之前注册的工具（避免"页面显示失败、实际还能调"），
 * 实例标 `error`；工具行保留（历史对话引用着 key）。
 */
@Injectable()
export class ConnectorSyncService implements OnApplicationBootstrap {
  constructor(
    @Inject(ConnectorRepository) private readonly repository: ConnectorRepository,
    @Inject(ConnectorService) private readonly connectors: ConnectorService,
    @Inject(CONNECTOR_DRIVERS) private readonly drivers: ConnectorDriverMap,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 启动时把已启用的连接器同步一遍（失败只记日志，不拖垮启动） */
  async onApplicationBootstrap(): Promise<void> {
    // 启动期同步失败**不拖垮启动**（AI 能力整体不可用是可接受状态，与工具种子同口径）：
    // 表还没迁移、某个库连不上、驱动配错，都只记日志。
    try {
      const page = await this.repository.list({ page: 1, size: 100, enabled: true })
      for (const entity of page.items) {
        await this.sync(entity.id)
      }
    } catch (error) {
      this.logger.error('ai.connector.bootstrap_sync_failed', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async sync(id: string): Promise<AiConnectorActionResult> {
    const entity = await this.connectors.require(id)
    const driver = this.connectors.driverOf(entity.driver)
    const runtime = this.connectors.runtimeOf(entity, driver)

    try {
      const capabilities = await driver.describe(runtime)
      const tools = capabilities.filter((cap): cap is ToolCapability => cap.kind === 'tool')

      // 白名单（null = 全开）
      const allowed = entity.allowedTools
      const selected = allowed ? tools.filter((tool) => allowed.includes(tool.name)) : tools
      const specs = selected.map((cap) => toConnectorToolSpec(entity, driver, cap, runtime))

      for (const [index, spec] of specs.entries()) {
        const cap = selected[index]
        await this.repository.upsertTool(entity.id, {
          toolKey: spec.key,
          remoteToolName: cap.name,
          title: cap.title,
          description: spec.description,
          paramSchema: cap.inputSchema,
        })
      }
      const disabled = await this.repository.disableMissing(
        entity.id,
        specs.map((spec) => spec.key),
      )

      // 先摘再注册：远端删掉的工具不能继续留在注册机里
      this.registry.removeDynamic(entity.id)
      const registered = this.registry.registerDynamic(entity.id, specs, (message) =>
        this.logger.warn('ai.connector.tool_conflict', { connector: entity.key, reason: message }),
      )

      await this.repository.update(entity.id, {
        status: ConnectorStatus._source.Ok.value,
        lastError: null,
        lastCheckedAt: new Date(),
        toolCount: registered.length,
      })

      this.logger.log('ai.connector.synced', {
        connector: entity.key,
        tools: registered.length,
        disabled,
      })
      return {
        ok: true,
        message: disabled > 0 ? `有 ${disabled} 个旧工具已被停用` : null,
        toolCount: registered.length,
      }
    } catch (error) {
      this.registry.removeDynamic(entity.id)
      const message = error instanceof Error ? error.message : String(error)
      await this.repository.update(entity.id, {
        status: ConnectorStatus._source.Error.value,
        lastError: message,
        lastCheckedAt: new Date(),
      })
      this.logger.error('ai.connector.sync_failed', { connector: entity.key, reason: message })
      return { ok: false, message, toolCount: 0 }
    }
  }

  /** 停用 / 删除时：摘掉工具，不写库（调用方负责状态） */
  disable(id: string): void {
    this.registry.removeDynamic(id)
  }
}
