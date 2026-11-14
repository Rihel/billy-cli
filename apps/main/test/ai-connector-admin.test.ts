import { describe, expect, it, vi } from 'vitest'
import type { AiConnectorEntity, AiToolEntity } from '@repo/db'
import type { AppLogger } from '@repo/kits'
import type { AiConnectorListDto } from '@repo/shared'
import {
  CONNECTOR_CATALOG,
  catalogEntryOf,
} from '../src/modules/ai-admin/connector/connector.catalog.js'
import {
  ConnectorConfigInvalidError,
  ConnectorNotFoundError,
} from '../src/modules/ai-admin/connector/connector.errors.js'
import type {
  ConnectorSyncEvent,
  ConnectorSyncNotifier,
} from '../src/modules/ai-admin/connector/connector.notifier.js'
import type { ConnectorStore } from '../src/modules/ai-admin/connector/connector.repository.js'
import { ConnectorService } from '../src/modules/ai-admin/connector/connector.service.js'
import type {
  ConnectorProbePort,
  ConnectorProbeResult,
} from '../src/modules/ai-admin/connector/connector.types.js'

/**
 * 连接器控制面（main 本地模块）单测。
 *
 * 全部用 fake：**不连数据库、不连外部服务、不发通知**。
 * - `FakeStore`：内存里的 `ai_connectors` / `ai_tools`（验证"写了什么、按什么顺序写"）；
 * - `probes` / `notifier`：可编排的替身（验证 test / sync 的边界）。
 *
 * 覆盖的语义：型号目录、创建（默认值 / 密钥 / 唯一 key / 驱动匹配）、列表、详情、
 * 更新（增量 / 清空密钥）、测试连接（只写状态）、同步（不在 main 写工具，只发事件）、删除。
 */

const PLAINTEXT_SECRET = 'super-secret-password'

/** 造一条连接器行（默认 PG，可直接喂给 fake store） */
const connectorOf = (over: Partial<AiConnectorEntity> = {}): AiConnectorEntity =>
  ({
    id: 'c1',
    key: 'pg',
    name: '主库',
    catalogKind: 'postgres',
    driver: 'sql',
    kind: 'custom',
    transport: 'db',
    authBase: 'secret',
    authSubject: 'none',
    config: {
      dialect: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'app',
      user: 'reader',
    },
    secrets: { password: PLAINTEXT_SECRET },
    enabled: true,
    status: 'unknown',
    lastError: null,
    lastCheckedAt: null,
    toolCount: 0,
    allowedTools: null,
    authState: null,
    authStateVersion: 0,
    createdAt: new Date('2026-11-14T00:00:00.000Z'),
    updatedAt: new Date('2026-11-14T00:00:00.000Z'),
    createdBy: null,
    updatedBy: null,
    deletedBy: null,
    deletedAt: null,
    ...over,
  }) as AiConnectorEntity

const toolOf = (over: Partial<AiToolEntity> = {}): AiToolEntity =>
  ({
    id: 't1',
    connectorId: 'c1',
    origin: 'connector',
    remoteToolName: 'query',
    toolKey: 'c-pg-query',
    title: '只读查询',
    description: null,
    paramSchema: null,
    enabled: true,
    ...over,
  }) as AiToolEntity

/** 内存 store：只实现控制面用到的方法，记录写操作与顺序 */
class FakeStore implements ConnectorStore {
  private seq = 0
  readonly rows = new Map<string, AiConnectorEntity>()
  readonly tools: AiToolEntity[] = []
  readonly ops: string[] = []
  readonly updates: Array<{ id: string; patch: Record<string, unknown> }> = []

  seed(entity: AiConnectorEntity): this {
    this.rows.set(entity.id, entity)
    return this
  }

  async findById(id: string): Promise<AiConnectorEntity | null> {
    return this.rows.get(id) ?? null
  }

  async findByKey(key: string): Promise<AiConnectorEntity | null> {
    for (const row of this.rows.values()) if (row.key === key) return row
    return null
  }

  async list(query: AiConnectorListDto) {
    const all = [...this.rows.values()]
    const filtered = all.filter((row) => {
      if (query.keyword && !row.key.includes(query.keyword.toLowerCase())) return false
      if (query.enabled !== undefined && row.enabled !== query.enabled) return false
      return true
    })
    const page = query.page ?? 1
    const size = query.size ?? 10
    return {
      items: filtered.slice((page - 1) * size, page * size),
      total: filtered.length,
      page,
      size,
    }
  }

  async create(data: Partial<AiConnectorEntity>): Promise<AiConnectorEntity> {
    this.seq += 1
    const now = new Date('2026-11-14T01:00:00.000Z')
    const entity = connectorOf({ ...data, id: `c${this.seq}`, createdAt: now, updatedAt: now })
    this.rows.set(entity.id, entity)
    this.ops.push('create')
    return entity
  }

  async update(id: string, patch: Partial<AiConnectorEntity>): Promise<void> {
    this.ops.push('update')
    this.updates.push({ id, patch: patch as Record<string, unknown> })
    const row = this.rows.get(id)
    if (row) Object.assign(row, patch)
  }

  async remove(id: string): Promise<void> {
    this.ops.push('remove')
    this.rows.delete(id)
  }

  async listTools(connectorId: string): Promise<AiToolEntity[]> {
    // 与真实仓储同口径：按 toolKey 升序
    return this.tools
      .filter((row) => row.connectorId === connectorId)
      .sort((a, b) => a.toolKey.localeCompare(b.toolKey))
  }

  async disableAllTools(connectorId: string): Promise<void> {
    this.ops.push(`disableAllTools:${connectorId}`)
  }
}

const fakeLogger = () =>
  ({
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }) as unknown as AppLogger

/** 一套装配好的 service + 可观测的替身 */
const setup = (
  options: {
    probe?: (driver: string, runtime: unknown) => Promise<ConnectorProbeResult>
    delivered?: boolean
  } = {},
) => {
  const store = new FakeStore()
  const events: ConnectorSyncEvent[] = []
  const probes: ConnectorProbePort = {
    probe: options.probe ?? (async () => ({ ok: true })),
  }
  const notifier: ConnectorSyncNotifier = {
    notify: async (event) => {
      events.push(event)
      return options.delivered ?? true
    },
  }
  const service = new ConnectorService(store, probes, notifier, fakeLogger())
  return { service, store, events }
}

describe('连接器控制面：型号目录', () => {
  it('返回四个内置型号，密钥字段与占位串按目录声明输出', () => {
    const { service } = setup()
    const catalog = service.catalog()

    expect(catalog.map((entry) => entry.kind)).toEqual(['postgres', 'mysql', 'redis', 'lark-cli'])
    const pg = catalog.find((entry) => entry.kind === 'postgres')!
    expect(pg.driver).toBe('sql')
    expect(pg.fields.find((field) => field.key === 'password')?.secret).toBe(true)
    // 未声明 placeholder / help 时统一给 null（前端不必判 undefined）
    expect(pg.fields.find((field) => field.key === 'host')?.help).toBeNull()
    expect(pg.fields.find((field) => field.key === 'host')?.placeholder).toBeNull()

    // 目录是代码常量：未知型号取不到
    expect(catalogEntryOf('nope')).toBeNull()
    expect(CONNECTOR_CATALOG).toHaveLength(4)
  })
})

describe('连接器控制面：创建', () => {
  it('合并型号默认值、存明文密钥、模型只回提示串', async () => {
    const { service, store } = setup()

    const model = await service.create({
      key: 'pg',
      name: '主库',
      catalogKind: 'postgres',
      driver: 'sql',
      config: { host: 'db.internal', database: 'app', user: 'reader' },
      secrets: { password: PLAINTEXT_SECRET },
      enabled: true,
    })

    const row = store.rows.get(model.id)!
    // 型号默认值（dialect / port）被补进 config
    expect(row.config).toMatchObject({ dialect: 'postgres', port: 5432, host: 'db.internal' })
    // 密钥明文入库（2026-10-01 工程取舍），但接口只回提示串
    expect(row.secrets?.password).toBe(PLAINTEXT_SECRET)
    expect(model.secretHints).toEqual([
      { name: 'password', label: '密码', required: true, hint: 'sup…word' },
    ])
    expect(JSON.stringify(model)).not.toContain(PLAINTEXT_SECRET)
    // 新实例状态是"未验证"，transport / auth 由配置契约推导
    expect(model.status).toBe('unknown')
    expect(model.transport).toBe('db')
    expect(model.authBase).toBe('secret')
    expect(model.kind).toBe('custom')
  })

  it('key 重复、型号与驱动不匹配、缺必填密钥、未知型号都拒绝', async () => {
    const { service, store } = setup()
    store.seed(connectorOf({ id: 'c9', key: 'pg' }))

    const base = {
      key: 'pg',
      name: '主库',
      catalogKind: 'postgres',
      driver: 'sql',
      config: {},
      secrets: { password: 'p@ssw0rd-long' },
      enabled: true,
    }

    await expect(service.create(base)).rejects.toBeInstanceOf(ConnectorConfigInvalidError)
    await expect(service.create({ ...base, key: 'pg2', driver: 'redis' })).rejects.toBeInstanceOf(
      ConnectorConfigInvalidError,
    )
    await expect(service.create({ ...base, key: 'pg2', secrets: {} })).rejects.toBeInstanceOf(
      ConnectorConfigInvalidError,
    )
    await expect(
      service.create({ ...base, key: 'pg2', catalogKind: 'nope' }),
    ).rejects.toBeInstanceOf(ConnectorConfigInvalidError)
    // 配置过不了契约（port 不是数字）也拦在入库前
    await expect(
      service.create({ ...base, key: 'pg2', config: { port: 'not-a-number' } }),
    ).rejects.toBeInstanceOf(ConnectorConfigInvalidError)
  })
})

describe('连接器控制面：列表与详情', () => {
  it('列表按分页映射为展示模型，详情带工具清单', async () => {
    const { service, store } = setup()
    store.seed(connectorOf({ id: 'c1', key: 'pg' }))
    store.seed(
      connectorOf({
        id: 'c2',
        key: 'cache',
        catalogKind: 'redis',
        driver: 'redis',
        enabled: false,
      }),
    )
    store.tools.push(
      toolOf(),
      toolOf({ id: 't2', remoteToolName: 'list_tables', toolKey: 'c-pg-list_tables' }),
    )

    const page = await service.list({ page: 1, size: 10 })
    expect(page.total).toBe(2)
    expect(page.items.map((item) => item.key)).toEqual(['pg', 'cache'])

    const enabledOnly = await service.list({ page: 1, size: 10, enabled: true })
    expect(enabledOnly.items.map((item) => item.key)).toEqual(['pg'])

    const detail = await service.detail('c1')
    expect(detail.tools.map((tool) => tool.toolKey)).toEqual(['c-pg-list_tables', 'c-pg-query'])
    expect(detail.tools[1]?.remoteName).toBe('query')

    await expect(service.detail('missing')).rejects.toBeInstanceOf(ConnectorNotFoundError)
  })
})

describe('连接器控制面：更新', () => {
  it('只改给的字段；config 重新补默认值；密钥空串 = 清空并校验必填', async () => {
    const { service, store } = setup()
    store.seed(connectorOf())

    const renamed = await service.update({ id: 'c1', name: '只读库' })
    expect(renamed.name).toBe('只读库')
    expect(renamed.config).toMatchObject({ dialect: 'postgres', port: 5432 })

    const merged = await service.update({
      id: 'c1',
      config: { host: 'db2.internal' },
      secrets: { password: 'another-secret-value' },
    })
    expect(merged.config).toMatchObject({ dialect: 'postgres', host: 'db2.internal' })
    expect(merged.secretHints[0]?.hint).toBe('ano…alue')

    // 必填密钥给空串 = 清空 → 不允许保存
    await expect(service.update({ id: 'c1', secrets: { password: '' } })).rejects.toBeInstanceOf(
      ConnectorConfigInvalidError,
    )
  })

  it('地址 / 凭证 / 品牌变化时通知 runtime 刷新缓存，改名 / 启停不发', async () => {
    const { service, store, events } = setup()
    store.seed(connectorOf())

    await service.update({ id: 'c1', name: '主库（改名）' })
    expect(events).toHaveLength(0)

    // sql 也按实例缓存连接池：改密码必须让 runtime 丢掉旧池
    await service.update({ id: 'c1', secrets: { password: 'rotated-secret-1' } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ version: 1, action: 'refresh', connectorId: 'c1' })

    store.seed(
      connectorOf({
        id: 'c2',
        key: 'lark',
        catalogKind: 'lark-cli',
        driver: 'lark-cli',
        transport: 'process',
        authBase: 'secret',
        authSubject: 'none',
        config: { appId: 'cli_old', brand: 'feishu' },
        secrets: { appSecret: 'lark-app-secret' },
      }),
    )
    await service.update({ id: 'c2', config: { appId: 'cli_new' } })
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ version: 1, action: 'refresh', connectorId: 'c2' })
  })

  it('启停只改 enabled（不同步、不碰工具行）', async () => {
    const { service, store, events } = setup()
    store.seed(connectorOf())

    const disabled = await service.update({ id: 'c1', enabled: false })
    expect(disabled.enabled).toBe(false)
    expect(store.updates.at(-1)?.patch).toEqual({ enabled: false })
    expect(store.ops).not.toContain('disableAllTools:c1')
    expect(events).toHaveLength(0)
  })
})

describe('连接器控制面：测试连接（只写状态）', () => {
  it('探活成功 → status=ok、清空 lastError；不写工具、不发同步事件', async () => {
    const { service, store, events } = setup({ probe: async () => ({ ok: true }) })
    store.seed(connectorOf({ status: 'error', lastError: '旧错误' }))

    const result = await service.test('c1')

    expect(result).toEqual({ ok: true, message: null })
    const patch = store.updates.at(-1)?.patch ?? {}
    expect(patch.status).toBe('ok')
    expect(patch.lastError).toBeNull()
    expect(patch.lastCheckedAt).toBeInstanceOf(Date)
    expect(store.tools).toHaveLength(0)
    expect(events).toHaveLength(0)
  })

  it('探活失败 / 抛错 → status=error，原文写进 lastError', async () => {
    const failed = setup({ probe: async () => ({ ok: false, message: 'ECONNREFUSED' }) })
    failed.store.seed(connectorOf())
    expect(await failed.service.test('c1')).toEqual({ ok: false, message: 'ECONNREFUSED' })
    expect(failed.store.updates.at(-1)?.patch).toMatchObject({
      status: 'error',
      lastError: 'ECONNREFUSED',
    })

    const thrown = setup({
      probe: async () => {
        throw new Error('连接超时（>5000ms）')
      },
    })
    thrown.store.seed(connectorOf())
    expect(await thrown.service.test('c1')).toEqual({
      ok: false,
      message: '连接超时（>5000ms）',
    })
    expect(thrown.store.updates.at(-1)?.patch.status).toBe('error')

    // 手工改库把 config 改坏：给"配置不合法"的结论，不抛 500
    const corrupted = setup()
    corrupted.store.seed(connectorOf({ config: { port: 'not-a-number' } }))
    const corruptResult = await corrupted.service.test('c1')
    expect(corruptResult.ok).toBe(false)
    expect(corruptResult.message).toBeTruthy()
    expect(corrupted.store.updates.at(-1)?.patch).toMatchObject({ status: 'error' })
  })
})

describe('连接器控制面：同步（异步通知，不在 main 执行）', () => {
  it('只发 sync 事件：不写 ai_tools、不写实例状态', async () => {
    const { service, store, events } = setup()
    store.seed(connectorOf({ toolCount: 3 }))

    const result = await service.sync('c1')

    expect(result.ok).toBe(true)
    expect(result.toolCount).toBe(3) // 当前库里的值，不是本次同步结果
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ version: 1, action: 'sync', connectorId: 'c1', key: 'pg' })
    // 同步的写库（ai_tools + status/tool_count）由 runtime 做，main 一行不写
    expect(store.updates).toHaveLength(0)
    expect(store.tools).toHaveLength(0)
  })

  it('通知送不出去（Redis / Kafka 都不可用）→ 回 ok=false，不假装成功', async () => {
    const { service, store } = setup({ delivered: false })
    store.seed(connectorOf())

    const result = await service.sync('c1')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('未能送达')
    expect(store.updates).toHaveLength(0)
  })

  it('库里配置被改坏（缺必填密钥）时先拦下，不把注定失败的任务推给 runtime', async () => {
    const { service, store, events } = setup()
    store.seed(connectorOf({ secrets: {} }))

    await expect(service.sync('c1')).rejects.toBeInstanceOf(ConnectorConfigInvalidError)
    expect(events).toHaveLength(0)
  })
})

describe('连接器控制面：删除', () => {
  it('先停用工具、再软删实例、最后通知 runtime 摘掉动态注册', async () => {
    const { service, store, events } = setup()
    store.seed(connectorOf())

    await service.remove('c1')

    expect(store.ops).toEqual(['disableAllTools:c1', 'remove'])
    expect(store.rows.has('c1')).toBe(false)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ version: 1, action: 'remove', connectorId: 'c1' })

    await expect(service.remove('c1')).rejects.toBeInstanceOf(ConnectorNotFoundError)
  })
})
