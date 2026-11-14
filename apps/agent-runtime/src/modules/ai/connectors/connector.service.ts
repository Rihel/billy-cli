import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, type PageQueryResult } from '@repo/kits'
import {
  ConnectorAuthBase,
  ConnectorAuthSubject,
  ConnectorKind,
  ConnectorStatus,
} from '@repo/shared'
import type {
  AiConnectorCreateDto,
  AiConnectorDetail,
  AiConnectorListDto,
  AiConnectorModel,
  AiConnectorUpdateDto,
} from '@repo/shared'
import { hintOf } from '../../ai-model/secret-hint.js'
import { CONNECTOR_DRIVERS } from './connector.types.js'
import type { ConnectorState, ConnectorStateSource } from './connector.state.js'
import type { ConnectorDriver, ConnectorDriverMap, ConnectorRuntime } from './connector.types.js'
import { CONNECTOR_CATALOG, catalogEntryOf } from './connector.catalog.js'
import { ConnectorRepository } from './connector.repository.js'
import { ConnectorConfigInvalidError, ConnectorNotFoundError } from './connector.errors.js'
import type { AiConnectorEntity } from '../../../database/entities/ai-connector-entity.js'

/**
 * 连接器服务（`/ai-connector/*`，后台管理员）—— 设计 `docs/design/ai-connector.md` §3.2 / §3.10。
 *
 * 四条口径：
 * - **配置与密钥分开**：`config` 过驱动 schema（默认值补齐），`secrets` 只存密钥明文、
 *   接口只回 `hintOf` 派生的提示串；
 * - **合法性只有驱动知道**：创建 / 更新前一律跑 `driver.config.parse`；
 * - **状态是"上次测试"**：`test()` 才写 `status` / `lastError` / `lastCheckedAt`；
 * - **启停不等于同步**：停用立刻让工具不可调，重新启用要再「同步」一次才恢复工具。
 */
@Injectable()
export class ConnectorService implements ConnectorStateSource {
  /** 网关每次调用都会问一次状态：缓存 5 秒，够挡住"同轮连续调用"的重复查库 */
  private readonly stateCache = new Map<string, { at: number; value: ConnectorState | null }>()

  constructor(
    @Inject(ConnectorRepository) private readonly repository: ConnectorRepository,
    @Inject(CONNECTOR_DRIVERS) private readonly drivers: ConnectorDriverMap,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 目录（代码声明：页面据此渲染卡片与表单） */
  catalog() {
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
    const page = await this.repository.list(query)
    return { ...page, items: page.items.map((entity) => this.toModel(entity)) }
  }

  async detail(id: string): Promise<AiConnectorDetail> {
    const entity = await this.require(id)
    const tools = await this.repository.listTools(id)
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

  async create(input: AiConnectorCreateDto): Promise<AiConnectorModel> {
    const entry = catalogEntryOf(input.catalogKind)
    if (!entry) throw new ConnectorConfigInvalidError(`未知的型号: ${input.catalogKind}`)
    if (entry.driver !== input.driver) {
      throw new ConnectorConfigInvalidError(
        `型号 ${entry.kind} 的驱动是 ${entry.driver}，不是 ${input.driver}`,
      )
    }
    const driver = this.driverOf(entry.driver)
    if (await this.repository.findByKey(input.key)) {
      throw new ConnectorConfigInvalidError(`key 已被占用: ${input.key}`)
    }
    // 型号默认值先合并（dialect / 默认端口这类"用户不用填但决定连谁"的字段）
    const config = driver.config.parse({ ...entry.defaults, ...input.config }) as Record<
      string,
      unknown
    >
    this.assertRequiredSecrets(driver, input.secrets)

    const entity = await this.repository.create({
      key: input.key,
      name: input.name,
      catalogKind: entry.kind,
      driver: entry.driver,
      kind: ConnectorKind._source.Custom.value,
      transport: driver.transport,
      authBase:
        driver.auth.base === 'none'
          ? ConnectorAuthBase._source.None.value
          : ConnectorAuthBase._source.Secret.value,
      authSubject:
        (driver.auth.subject ?? 'none') === 'oauth'
          ? ConnectorAuthSubject._source.OAuth.value
          : ConnectorAuthSubject._source.None.value,
      config,
      secrets: input.secrets,
      enabled: input.enabled,
      status: ConnectorStatus._source.Unknown.value,
    })

    this.stateCache.delete(entity.id)
    this.logger.log('ai.connector.created', {
      id: entity.id,
      key: entity.key,
      driver: entity.driver,
    })
    return this.toModel(entity)
  }

  async update(input: AiConnectorUpdateDto): Promise<AiConnectorModel> {
    const entity = await this.require(input.id)
    const driver = this.driverOf(entity.driver)

    const patch: Partial<AiConnectorEntity> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.enabled !== undefined) patch.enabled = input.enabled
    if (input.config !== undefined) {
      const entry = catalogEntryOf(entity.catalogKind)
      patch.config = driver.config.parse({
        ...entry?.defaults,
        ...input.config,
      }) as Record<string, unknown>
    }
    if (input.secrets !== undefined) {
      // 空串 = 清掉该密钥；其余字段按"给了才改"合并
      const next: Record<string, string> = { ...entity.secrets }
      for (const [key, value] of Object.entries(input.secrets)) {
        if (value === '') delete next[key]
        else next[key] = value
      }
      patch.secrets = next
      this.assertRequiredSecrets(driver, next)
    }

    await this.repository.update(entity.id, patch)

    // 应用凭证 / 品牌变了，旧授权（用户 token）对新应用无效：清掉状态与 CLI HOME，
    // 下次调用会重新 config init，授权链接也要重新生成。
    const authChanged =
      (input.secrets !== undefined && Object.keys(input.secrets).length > 0) ||
      (input.config !== undefined && ('appId' in input.config || 'brand' in input.config))
    if (authChanged && driver.auth.subject !== 'none') {
      await driver.dispose?.(entity.id)
    }

    const saved = await this.require(entity.id)
    this.stateCache.delete(entity.id)
    this.logger.log('ai.connector.updated', { id: saved.id, key: saved.key })
    return this.toModel(saved)
  }

  async remove(id: string): Promise<void> {
    const entity = await this.require(id)
    const driver = this.driverOf(entity.driver)
    await driver.dispose?.(entity.id)
    await this.repository.disableAll(entity.id)
    await this.repository.remove(entity.id)
    this.stateCache.delete(entity.id)
    this.logger.log('ai.connector.removed', { id, key: entity.key })
  }

  /** 测试连接：只写状态，不动工具 */
  async test(id: string): Promise<{ ok: boolean; message: string | null }> {
    const entity = await this.require(id)
    const driver = this.driverOf(entity.driver)
    const runtime = this.runtimeOf(entity, driver)
    let message: string | null = null
    let ok = false
    try {
      const result = await driver.probe(runtime)
      ok = result.ok
      message = result.message ?? null
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    await this.repository.update(entity.id, {
      status: ok ? ConnectorStatus._source.Ok.value : ConnectorStatus._source.Error.value,
      lastError: message,
      lastCheckedAt: new Date(),
    })
    return { ok, message }
  }

  /** 取实例（不存在就抛 3409） */
  async require(id: string): Promise<AiConnectorEntity> {
    const entity = await this.repository.findById(id)
    if (!entity) throw new ConnectorNotFoundError(id)
    return entity
  }

  /** 网关插件要的窄接口：实例还活着吗、密钥齐不齐（5 秒缓存） */
  async stateOf(connectorId: string): Promise<ConnectorState | null> {
    const hit = this.stateCache.get(connectorId)
    if (hit && Date.now() - hit.at < 5_000) return hit.value

    let value: ConnectorState | null = null
    try {
      const entity = await this.repository.findById(connectorId)
      if (entity) {
        value = {
          enabled: entity.enabled,
          missingSecret: this.hasMissingSecret(entity),
          name: entity.name,
          secrets: entity.secrets ?? {},
        }
      }
    } catch {
      // 状态读不出来就别放行：宁可这次调用失败，也不要绕开总闸去连外部服务
      value = null
    }
    this.stateCache.set(connectorId, { at: Date.now(), value })
    return value
  }

  /** 必填密钥是否有缺（实例被手动改库改坏时也能发现） */
  private hasMissingSecret(entity: AiConnectorEntity): boolean {
    const driver = this.drivers.get(entity.driver)
    if (!driver) return true
    return driver.secrets
      .filter((field) => field.secret && field.required)
      .some((field) => !entity.secrets?.[field.key]?.trim())
  }

  /** 取驱动（未注册的驱动 = 配置里写了不存在的接法） */
  driverOf(kind: string): ConnectorDriver {
    const driver = this.drivers.get(kind)
    if (!driver) throw new ConnectorConfigInvalidError(`未知的驱动: ${kind}`)
    return driver
  }

  /** 组装一次调用 / 探测要用的运行时（密钥只在这一层出现） */
  runtimeOf(entity: AiConnectorEntity, driver: ConnectorDriver): ConnectorRuntime {
    return {
      instanceId: entity.id,
      key: entity.key,
      config: driver.config.parse(entity.config ?? {}) as Record<string, unknown>,
      secrets: entity.secrets ?? {},
    }
  }

  /** 实例 → 展示模型（密钥只回提示串） */
  toModel(entity: AiConnectorEntity): AiConnectorModel {
    const driver = this.drivers.get(entity.driver)
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
      secretHints: (driver?.secrets ?? [])
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

  /** 必填密钥没给 → 不让他存（比"存下来跑的时候才报错"好排查） */
  private assertRequiredSecrets(driver: ConnectorDriver, secrets: Record<string, string>): void {
    const missing = driver.secrets
      .filter((field) => field.secret && field.required)
      .filter((field) => !secrets[field.key]?.trim())
      .map((field) => field.label)
    if (missing.length > 0) {
      throw new ConnectorConfigInvalidError(`缺少必填密钥：${missing.join('、')}`)
    }
  }
}
