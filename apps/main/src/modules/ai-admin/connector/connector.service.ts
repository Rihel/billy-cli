import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, type PageQueryResult } from '@repo/kits'
import {
  ConnectorAuthBase,
  ConnectorAuthSubject,
  ConnectorKind,
  ConnectorStatus,
} from '@repo/shared'
import type {
  AiConnectorActionResult,
  AiConnectorCatalogEntry,
  AiConnectorCreateDto,
  AiConnectorDetail,
  AiConnectorListDto,
  AiConnectorModel,
  AiConnectorUpdateDto,
} from '@repo/shared'
import type { AiConnectorEntity } from '@repo/db'
import { CONNECTOR_CATALOG, catalogEntryOf } from './connector.catalog.js'
import { ConnectorConfigInvalidError, ConnectorNotFoundError } from './connector.errors.js'
import { hintOf } from './connector.hint.js'
import {
  CONNECTOR_SYNC_NOTIFIER,
  messageOf,
  type ConnectorSyncEvent,
  type ConnectorSyncNotifier,
} from './connector.notifier.js'
import { CONNECTOR_STORE, type ConnectorStore } from './connector.repository.js'
import { specOfDriver } from './connector.specs.js'
import { CONNECTOR_PROBE } from './connector.types.js'
import type {
  ConnectorCatalogDecl,
  ConnectorProbePort,
  ConnectorRuntime,
  ConnectorSpec,
} from './connector.types.js'

/**
 * 连接器控制面服务（`/ai-connector/*`，后台管理员）—— 设计 `docs/design/ai-connector.md`
 * §3.2 / §3.10，按"main 只做控制面"的架构重切。
 *
 * 与 runtime 版 `ConnectorService` 的差别只有一刀：**没有驱动实例，也没有工具注册机**。
 * - 创建 / 更新 / 删除 / 列表 / 详情：纯 DB CRUD（`@repo/db` 实体，main 与 runtime 同源）；
 * - `test`：只测连接配置（`ConnectorProbeService`），**不注册工具**；
 * - `sync`：**不在 main 执行**。main 只发事件（Redis / Kafka），由 agent-runtime 的
 *   `ConnectorSyncService` 去连接、发现能力、写 `ai_tools`、注册动态工具、回写
 *   `status` / `tool_count`；同步结果的落库发生在 runtime 侧。
 *
 * 四条口径（与 runtime 版一致，别改）：
 * - **配置与密钥分开**：`config` 过配置契约（默认值补齐），`secrets` 只存密钥明文，
 *   接口只回 `hintOf` 派生的提示串；
 * - **合法性只有配置契约知道**：创建 / 更新前一律跑 `spec.config.parse`；
 * - **状态是"上次测试"**：只有 `test` 会写 `status` / `lastError` / `lastCheckedAt`；
 *   同步后的状态由 runtime 回写；
 * - **启停不等于同步**：停用立刻让工具不可调（runtime 网关按 `enabled` 判），
 *   重新启用要再「同步」一次才恢复工具。
 */
@Injectable()
export class ConnectorService {
  constructor(
    @Inject(CONNECTOR_STORE) private readonly store: ConnectorStore,
    @Inject(CONNECTOR_PROBE) private readonly probes: ConnectorProbePort,
    @Inject(CONNECTOR_SYNC_NOTIFIER) private readonly notifier: ConnectorSyncNotifier,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 目录（代码声明：页面据此渲染卡片与表单） */
  catalog(): AiConnectorCatalogEntry[] {
    return CONNECTOR_CATALOG.map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      description: entry.description,
      driver: entry.driver,
      transport: entry.transport,
      category: entry.category,
      phase: entry.phase,
      authHint: entry.authHint,
      fields: entry.fields.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        secret: field.secret,
        required: field.required ?? false,
        placeholder: field.placeholder ?? null,
        help: field.help ?? null,
      })),
    }))
  }

  async list(query: AiConnectorListDto): Promise<PageQueryResult<AiConnectorModel>> {
    const page = await this.store.list(query)
    return { ...page, items: page.items.map((entity) => this.toModel(entity)) }
  }

  /** 详情（含它产出的工具清单；工具治理仍在 `/ai-tool/*`） */
  async detail(id: string): Promise<AiConnectorDetail> {
    const entity = await this.require(id)
    const tools = await this.store.listTools(id)
    return {
      ...this.toModel(entity),
      tools: tools.map((row) => ({
        toolKey: row.toolKey,
        remoteName: row.remoteToolName ?? row.toolKey,
        title: row.title,
        enabled: row.enabled,
      })),
    }
  }

  /** 新建实例：型号 → 驱动 → 配置契约；密钥只落库、只回提示串 */
  async create(input: AiConnectorCreateDto): Promise<AiConnectorModel> {
    const entry = catalogEntryOf(input.catalogKind)
    if (!entry) throw new ConnectorConfigInvalidError(`未知的型号: ${input.catalogKind}`)
    if (entry.driver !== input.driver) {
      throw new ConnectorConfigInvalidError(
        `型号 ${entry.kind} 的驱动是 ${entry.driver}，不是 ${input.driver}`,
      )
    }
    const spec = this.specOf(entry.driver)
    if (await this.store.findByKey(input.key)) {
      throw new ConnectorConfigInvalidError(`key 已被占用: ${input.key}`)
    }

    // 型号默认值先合并（dialect / 默认端口这类"用户不用填但决定连谁"的字段）
    const config = this.parseConfig(spec, entry, input.config)
    this.assertRequiredSecrets(spec, input.secrets)

    const entity = await this.store.create({
      key: input.key,
      name: input.name,
      catalogKind: entry.kind,
      driver: entry.driver,
      kind: ConnectorKind._source.Custom.value,
      transport: spec.transport,
      authBase:
        spec.auth.base === 'none'
          ? ConnectorAuthBase._source.None.value
          : ConnectorAuthBase._source.Secret.value,
      authSubject:
        spec.auth.subject === 'oauth'
          ? ConnectorAuthSubject._source.OAuth.value
          : ConnectorAuthSubject._source.None.value,
      config,
      secrets: input.secrets,
      enabled: input.enabled,
      status: ConnectorStatus._source.Unknown.value,
    })

    this.logger.log('ai.connector.created', {
      id: entity.id,
      key: entity.key,
      driver: entity.driver,
    })
    return this.toModel(entity)
  }

  /** 更新（省略的字段 = 不改；密钥给空串 = 清空） */
  async update(input: AiConnectorUpdateDto): Promise<AiConnectorModel> {
    const entity = await this.require(input.id)
    const spec = this.specOf(entity.driver)
    const entry = catalogEntryOf(entity.catalogKind)

    const patch: Partial<AiConnectorEntity> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.enabled !== undefined) patch.enabled = input.enabled
    if (input.config !== undefined) {
      patch.config = this.parseConfig(spec, entry, input.config)
    }
    if (input.secrets !== undefined) {
      // 空串 = 清掉该密钥；其余字段按"给了才改"合并
      const next: Record<string, string> = { ...entity.secrets }
      for (const [key, value] of Object.entries(input.secrets)) {
        if (value === '') delete next[key]
        else next[key] = value
      }
      this.assertRequiredSecrets(spec, next)
      patch.secrets = next
    }

    await this.store.update(entity.id, patch)
    const saved = await this.require(entity.id)

    // 地址 / 凭证 / 品牌变了：runtime 里这条实例的连接池、CLI HOME、用户授权状态都失效了。
    // main 这边没有这些进程内状态，只能**通知 runtime 丢掉缓存**；不做同步（同步是显式动作，
    // 改配置不自动重建工具面，与"启停不等于同步"同口径）。
    //
    // 为什么所有驱动都通知（不只 cli-login / oauth）：sql / redis 也按实例缓存了连接池，
    // 改 host / 密码后不丢缓存就会一直用旧凭证连旧地址。
    const connectionChanged =
      input.config !== undefined ||
      (input.secrets !== undefined && Object.keys(input.secrets).length > 0)
    if (connectionChanged) {
      await this.notify('refresh', entity)
    }

    this.logger.log('ai.connector.updated', { id: saved.id, key: saved.key })
    return this.toModel(saved)
  }

  /**
   * 删除（软删）：先停用工具行、再软删实例、最后通知 runtime 摘掉动态工具。
   *
   * 顺序不能反：先删库再通知，runtime 收到事件时已经读不到实例（不会把工具又同步回来）；
   * 通知失败也不回滚删除——runtime 的网关按 `enabled` / 实例不存在拒绝调用，最多留下
   * 一份"内存里还没摘掉"的工具注册，下一次同步或重启自然清掉。
   */
  async remove(id: string): Promise<void> {
    const entity = await this.require(id)
    await this.store.disableAllTools(entity.id)
    await this.store.remove(entity.id)
    await this.notify('remove', entity)
    this.logger.log('ai.connector.removed', { id, key: entity.key })
  }

  /**
   * 测试连接：只写状态，**不注册工具**。
   *
   * 探活失败不抛 HTTP 错误，而是把 `status=error` + 原文写回库里 —— 后台页面要的是
   * "这条配置连不上，原因是 X"，不是一个 500。
   */
  async test(id: string): Promise<AiConnectorActionResult> {
    const entity = await this.require(id)
    const spec = this.specOf(entity.driver)

    let message: string | null = null
    let ok = false
    try {
      // 配置解析也放进 try：手工改库改坏的行应当得到一个"配置不合法"的结论，而不是 500
      const runtime = this.runtimeOf(entity, spec)
      const result = await this.probes.probe(entity.driver, runtime)
      ok = result.ok
      message = result.message ?? null
    } catch (error) {
      message = messageOf(error)
    }

    await this.store.update(entity.id, {
      status: ok ? ConnectorStatus._source.Ok.value : ConnectorStatus._source.Error.value,
      lastError: message,
      lastCheckedAt: new Date(),
    })
    this.logger.log('ai.connector.tested', { id: entity.id, key: entity.key, ok })
    return { ok, message }
  }

  /**
   * 同步（异步）：控制面只做两件事 —— 校验这份配置能交给 runtime，发一条同步事件。
   *
   * **明确边界**：main 不连远端列能力、不写 `ai_tools` 的工具行、不注册工具。
   * 那三件事都在 agent-runtime 的 `ConnectorSyncService.sync(connectorId)` 里；
   * 同步结论（`status` / `lastError` / `lastCheckedAt` / `toolCount`）也由 runtime 回写。
   *
   * 返回 `toolCount` 是**当前**库里的值（本次同步结果要轮询详情页看 runtime 回写）。
   */
  async sync(id: string): Promise<AiConnectorActionResult> {
    const entity = await this.require(id)
    const spec = this.specOf(entity.driver)
    const entry = catalogEntryOf(entity.catalogKind)

    // 配置在保存时已经校验过；这里再解析一次，拦住"手工改库改坏"的情况，
    // 避免把一条注定失败的任务推给 runtime。
    this.parseConfig(spec, entry, entity.config ?? {})
    this.assertRequiredSecrets(spec, entity.secrets ?? {})

    const delivered = await this.notify('sync', entity)
    if (!delivered) {
      return {
        ok: false,
        message: '同步请求未能送达 agent-runtime（Redis / Kafka 均不可用），请稍后重试',
        toolCount: entity.toolCount,
      }
    }
    return {
      ok: true,
      message:
        '已通知 agent-runtime 同步；工具清单与状态会在运行期写入（main 不执行工具注册），稍后刷新详情查看',
      toolCount: entity.toolCount,
    }
  }

  /** 取实例（不存在就抛 3409） */
  async require(id: string): Promise<AiConnectorEntity> {
    const entity = await this.store.findById(id)
    if (!entity) throw new ConnectorNotFoundError(id)
    return entity
  }

  /** 实例 → 展示模型（密钥只回提示串，永不回明文） */
  toModel(entity: AiConnectorEntity): AiConnectorModel {
    const spec = specOfDriver(entity.driver)
    return {
      id: entity.id,
      key: entity.key,
      name: entity.name,
      catalogKind: entity.catalogKind,
      driver: entity.driver,
      kind: entity.kind as AiConnectorModel['kind'],
      transport: entity.transport as AiConnectorModel['transport'],
      authBase: entity.authBase as AiConnectorModel['authBase'],
      authSubject: entity.authSubject as AiConnectorModel['authSubject'],
      config: entity.config ?? {},
      secretHints: (spec?.secrets ?? [])
        .filter((field) => field.secret)
        .map((field) => ({
          name: field.key,
          label: field.label,
          required: field.required ?? false,
          hint: entity.secrets?.[field.key] ? hintOf(entity.secrets[field.key]) : null,
        })),
      enabled: entity.enabled,
      status: entity.status as AiConnectorModel['status'],
      lastError: entity.lastError,
      lastCheckedAt: entity.lastCheckedAt,
      toolCount: entity.toolCount,
      allowedTools: entity.allowedTools,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    }
  }

  /** 取配置契约（未注册的驱动 = 配置里写了不存在的接法） */
  private specOf(driver: string): ConnectorSpec {
    const spec = specOfDriver(driver)
    if (!spec) throw new ConnectorConfigInvalidError(`未知的驱动: ${driver}`)
    return spec
  }

  /** 型号默认值 + 用户配置 → 契约解析（补默认值、拦坏类型） */
  private parseConfig(
    spec: ConnectorSpec,
    entry: ConnectorCatalogDecl | null,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    try {
      return spec.config.parse({ ...entry?.defaults, ...config }) as Record<string, unknown>
    } catch (error) {
      throw new ConnectorConfigInvalidError(messageOf(error))
    }
  }

  /** 必填密钥没给 → 不让他存（比"存下来跑的时候才报错"好排查） */
  private assertRequiredSecrets(
    spec: ConnectorSpec,
    secrets: Record<string, string> | null | undefined,
  ): void {
    const missing = spec.secrets
      .filter((field) => field.secret && field.required)
      .filter((field) => !secrets?.[field.key]?.trim())
      .map((field) => field.label)
    if (missing.length > 0) {
      throw new ConnectorConfigInvalidError(`缺少必填密钥：${missing.join('、')}`)
    }
  }

  /** 组装一次探活要用的运行时（密钥只在这一层出现，不写日志） */
  private runtimeOf(entity: AiConnectorEntity, spec: ConnectorSpec): ConnectorRuntime {
    return {
      instanceId: entity.id,
      key: entity.key,
      config: spec.config.parse(entity.config ?? {}) as Record<string, unknown>,
      secrets: entity.secrets ?? {},
    }
  }

  /**
   * 发一条 runtime 事件（CRUD 附带通知与显式同步共用）。
   *
   * 通知失败不抛给 HTTP：删除 / 凭证变更的 DB 已经改完，运行期有 `enabled` /
   * 实例不存在兜底；显式同步由调用方按返回值回结论（ok=false）。
   */
  private async notify(
    action: ConnectorSyncEvent['action'],
    entity: AiConnectorEntity,
  ): Promise<boolean> {
    const event: ConnectorSyncEvent = {
      version: 1,
      action,
      connectorId: entity.id,
      key: entity.key,
      requestedAt: new Date().toISOString(),
    }
    try {
      return await this.notifier.notify(event)
    } catch (error) {
      this.logger.error('ai.connector.notify_failed', {
        connectorId: event.connectorId,
        action: event.action,
        reason: messageOf(error),
      })
      return false
    }
  }
}
