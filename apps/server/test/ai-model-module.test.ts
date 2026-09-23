import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Db, setAuditUserProvider, type AppLogger } from '@repo/kits'
import { AiProviderKind } from '@repo/shared'
import { AiProviderEntity } from '../src/database/entities/ai-provider-entity.js'
import { AiModelEntity } from '../src/database/entities/ai-model-entity.js'
import {
  AiModelRepository,
  AiModelService,
  AiProviderRepository,
  decryptSecret,
  hintOf,
  type AiModelConfig,
} from '../src/modules/ai-model/index.js'
import {
  MOCK_MODEL_LIST,
  startMockModelServer,
  type MockModelServer,
} from './helpers/mock-model-server.js'

/**
 * AI 模型模块的集成测试：**打真实数据库 + 离线 mock 供应商服务**（不依赖任何外部密钥）。
 *
 * 覆盖的是设计文档 §4.8 / §4.9 的硬规则，而不是"方法能跑通"：
 * 密钥只进不出（加密存 + 只回 hint）、同步落明细（原始 JSON 进 raw）、重复同步幂等、
 * 同步**不覆盖启停**、运行时**只用库里启用的模型**（库空 3406、禁用报错）。
 *
 * 前置：`apps/server/.env` 的 DB_URL 指向可用库，且已执行迁移（含 `slug` 列）。
 */

/** 测试用加密口令（不进环境变量，避免污染开发库的历史密文口径） */
const TEST_SECRET = `test-secret-${randomBytes(8).toString('hex')}`
/** 供应商密钥（断言提示 `sk-…abcd`） */
const TEST_API_KEY = 'sk-test-abcdefgh-abcd'
const TEST_USER = 'admin_ai_model_test'

const dbErrors: unknown[] = []
const silentLogger = {
  setContext: () => undefined,
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: (...args: unknown[]) => dbErrors.push(args),
  debug: () => undefined,
} as unknown as AppLogger

let db: Db
let providers: AiProviderRepository
let models: AiModelRepository
let service: AiModelService
let mock: MockModelServer

/** 本测试自己造的数据（结束时物理删掉，不污染开发库） */
const createdProviderIds: string[] = []
/** 测试开始前本来启用的行（"库空"场景需要全局没有可用模型，测完原样恢复） */
const pausedProviderIds: string[] = []
const pausedModelIds: string[] = []

const providerIdsOf = async (): Promise<string[]> => {
  const rows = await db.dataSource.query<{ id: string }[]>(
    'SELECT id FROM ai_providers WHERE deleted_at IS NULL',
  )
  return rows.map((row) => row.id)
}

beforeAll(async () => {
  mock = await startMockModelServer()

  db = new Db(
    {
      url: process.env.DB_URL!,
      sync: false,
      entities: [AiProviderEntity, AiModelEntity],
    } as never,
    silentLogger,
  )
  await db.onApplicationBootstrap()
  if (!db.dataSource.isInitialized) {
    throw new Error(`数据库初始化失败：${JSON.stringify(dbErrors)}`)
  }

  // 审计操作人：模拟后台管理员发起的写操作
  setAuditUserProvider(() => TEST_USER)

  providers = new AiProviderRepository(db)
  models = new AiModelRepository(db)
  const config: AiModelConfig = {
    encryptionKey: TEST_SECRET,
    fallbackSecret: undefined,
    seedFromEnv: false,
  }
  service = new AiModelService(providers, models, config, silentLogger)

  // 开发库里若已有启用中的供应商 / 模型，临时禁用（"库空 → 3406"要做全库断言），结束时恢复
  const enabledProviders = await db.dataSource.query<{ id: string }[]>(
    'SELECT id FROM ai_providers WHERE enabled = true',
  )
  const enabledModels = await db.dataSource.query<{ id: string }[]>(
    'SELECT id FROM ai_models WHERE enabled = true',
  )
  pausedProviderIds.push(...enabledProviders.map((row) => row.id))
  pausedModelIds.push(...enabledModels.map((row) => row.id))
  if (pausedProviderIds.length > 0) {
    await db.dataSource.query('UPDATE ai_providers SET enabled = false WHERE id = ANY($1)', [
      pausedProviderIds,
    ])
  }
  if (pausedModelIds.length > 0) {
    await db.dataSource.query('UPDATE ai_models SET enabled = false WHERE id = ANY($1)', [
      pausedModelIds,
    ])
  }
})

afterAll(async () => {
  setAuditUserProvider(undefined)
  // 清理自己造的数据（物理删，避免污染开发库）
  if (createdProviderIds.length > 0) {
    await db.dataSource.query('DELETE FROM ai_models WHERE provider_id = ANY($1)', [
      createdProviderIds,
    ])
    await db.dataSource.query('DELETE FROM ai_providers WHERE id = ANY($1)', [createdProviderIds])
  }
  // 恢复测试前被临时禁用的行
  if (pausedProviderIds.length > 0) {
    await db.dataSource.query('UPDATE ai_providers SET enabled = true WHERE id = ANY($1)', [
      pausedProviderIds,
    ])
  }
  if (pausedModelIds.length > 0) {
    await db.dataSource.query('UPDATE ai_models SET enabled = true WHERE id = ANY($1)', [
      pausedModelIds,
    ])
  }
  await db.onApplicationShutdown()
  await mock.close()
})

describe('AI 模型模块（真实数据库 + mock 供应商）', () => {
  it('① 密钥提示：hintOf 形如 sk-…abcd（太短的只留末 2 位）', () => {
    expect(hintOf('sk-1234abcd')).toBe('sk-…abcd')
    expect(hintOf('sk-test-abcdefgh-abcd')).toBe('sk-…abcd')
    expect(hintOf('ab12')).toBe('…12')
  })

  it('② 库空 → resolveForRuntime 抛 3406（绝不回落环境变量）', async () => {
    await expect(service.resolveForRuntime()).rejects.toMatchObject({ code: 3406 })
    await expect(service.listAvailable()).resolves.toEqual({ models: [], defaultModelId: null })
  })

  it('③ 建供应商：slug 由名称生成；密钥加密入库，对外只回 hint / hasApiKey', async () => {
    const created = await service.createProvider({
      name: 'My Mock Gateway',
      kind: AiProviderKind.OpenaiCompatible,
      baseUrl: mock.baseURL,
      apiKey: TEST_API_KEY,
      enabled: true,
    })
    createdProviderIds.push(created.id)

    // 对外模型：有 slug / hint，绝无明文
    expect(created.slug).toBe('my-mock-gateway')
    expect(created.apiKeyHint).toBe('sk-…abcd')
    expect((created as { hasApiKey: boolean }).hasApiKey).toBe(true)
    expect(Object.keys(created)).not.toContain('apiKey')
    expect(JSON.stringify(created)).not.toContain(TEST_API_KEY)

    // 库里只有密文，且能用口令解回原文
    const rows = await db.dataSource.query<{ api_key_cipher: string; api_key_hint: string }[]>(
      'SELECT api_key_cipher, api_key_hint FROM ai_providers WHERE id = $1',
      [created.id],
    )
    expect(rows[0].api_key_cipher).not.toContain(TEST_API_KEY)
    expect(decryptSecret(rows[0].api_key_cipher, TEST_SECRET)).toBe(TEST_API_KEY)
  })

  it('③b 名称里没有可用 ASCII 字符 → slug 无法生成，明确报错（4001）', async () => {
    await expect(
      service.createProvider({
        name: '纯中文名称',
        kind: AiProviderKind.OpenaiCompatible,
        baseUrl: mock.baseURL,
        apiKey: TEST_API_KEY,
      }),
    ).rejects.toMatchObject({ code: 4001 })
  })

  it('④ 同步：落模型明细，供应商原始 JSON 全量进 raw；窗口字段拿不到就是 null', async () => {
    const providerId = createdProviderIds[0]
    const result = await service.syncProvider({ providerId })

    expect(result).toMatchObject({ created: 2, updated: 0, unchanged: 0, missing: 0, total: 2 })
    // 同步确实打了 mock 的 GET /models，且带 Bearer 密钥
    expect(mock.listRequests.at(-1)?.url).toContain('/models')
    expect(mock.listRequests.at(-1)?.authorization).toBe(`Bearer ${TEST_API_KEY}`)

    const page = await service.listModels({ providerId, page: 1, size: 10 })
    expect(page.total).toBe(2)
    expect(page.items.map((item) => item.modelKey)).toEqual(['mock-chat', 'mock-reasoner'])

    const first = page.items[0]
    expect(first.source).toBe('sync')
    expect(first.enabled).toBe(true)
    // 原始 JSON 全量留存（不裁剪）
    expect(first.raw).toEqual(MOCK_MODEL_LIST[0])
    // 供应商没给窗口 → null（不编造）
    expect(first.contextWindow).toBeNull()
    expect(first.displayName).toBe('mock-chat')

    // 供应商成功同步后清空 lastSyncError、写 lastSyncedAt
    const detail = await service.detailProvider({ providerId })
    expect(detail.lastSyncError).toBeNull()
    expect(detail.lastSyncedAt).toBeTruthy()
    expect((detail as { modelCount: number }).modelCount).toBe(2)
  })

  it('⑤ 重复同步幂等：不插重复行，全部记为 unchanged', async () => {
    const providerId = createdProviderIds[0]
    const again = await service.syncProvider({ providerId })
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2, total: 2 })

    const count = await models.countModels(providerId)
    expect(count).toBe(2)
  })

  it('⑥ 同步不覆盖启停：手工禁用某模型后再同步，enabled 保持不变，也没有重复行', async () => {
    const providerId = createdProviderIds[0]
    const page = await service.listModels({ providerId, page: 1, size: 10 })
    const target = page.items.find((item) => item.modelKey === 'mock-reasoner')!

    await service.updateModel({ modelId: target.id, enabled: false })
    await service.syncProvider({ providerId })

    const after = await models.findById(target.id)
    expect(after?.enabled).toBe(false)
    expect(await models.countModels(providerId)).toBe(2)
  })

  it('⑦ resolveForRuntime：只用启用模型；禁用 / 不存在的 id 报错；库里全禁用 → 3406', async () => {
    const providerId = createdProviderIds[0]
    const page = await service.listModels({ providerId, page: 1, size: 10 })
    const disabled = page.items.find((item) => item.modelKey === 'mock-reasoner')!

    // 未指定 modelId → 默认取"第一个启用"的（供应商创建时间 + modelKey 排序）
    const resolved = await service.resolveForRuntime()
    expect(resolved.modelKey).toBe('mock-chat')
    expect(resolved.modelRef).toBe(
      `${(await providers.findById(providerId))!.slug}/mock-chat`,
    )
    expect(resolved.apiKey).toBe(TEST_API_KEY)
    expect(resolved.baseURL).toBe(mock.baseURL)
    expect(resolved.contextWindow).toBeNull()

    // 指定被禁用的模型 → 明确报错（3402）
    await expect(service.resolveForRuntime(disabled.id)).rejects.toMatchObject({ code: 3402 })
    // 不存在的 id → 3402
    await expect(service.resolveForRuntime('not-exist-model')).rejects.toMatchObject({ code: 3402 })

    // 列表里只有启用的两个之外的一个 → 清单里不含被禁用的
    const available = await service.listAvailable()
    expect(available.models.map((item) => item.modelKey)).toEqual(['mock-chat'])
    expect(available.models[0].providerSlug).toBe((await providers.findById(providerId))!.slug)
    expect(available.defaultModelId).toBe(resolved.id)
  })

  it('⑧ provider/test：连通性测试只测不落库，回来的是模型数', async () => {
    const result = await service.testProvider({
      kind: AiProviderKind.OpenaiCompatible,
      baseUrl: mock.baseURL,
      apiKey: TEST_API_KEY,
    })
    expect(result.ok).toBe(true)
    expect(result.modelCount).toBe(MOCK_MODEL_LIST.length)
    expect(result.endpoint).toContain('/models')
    expect(result.error).toBeNull()
  })

  it('⑨ updateProvider 三态：apiKey 省略不改 / 空串清空、baseUrl null 真的清空、name+slug 冲突报 4001', async () => {
    const providerId = createdProviderIds[0]
    const cipherOf = async (): Promise<string | null> => {
      const rows = await db.dataSource.query<{ api_key_cipher: string | null }[]>(
        'SELECT api_key_cipher FROM ai_providers WHERE id = $1',
        [providerId],
      )
      return rows[0].api_key_cipher
    }
    const before = await cipherOf()

    // apiKey 省略 → 不改（密文与提示都不动）；baseUrl 给字符串 → 覆盖
    const kept = await service.updateProvider({ providerId, baseUrl: mock.baseURL })
    expect(kept.apiKeyHint).toBe('sk-…abcd')
    expect(await cipherOf()).toBe(before)

    // baseUrl = null → 真的清空（落库 NULL，运行时回到官方默认地址）
    const cleared = await service.updateProvider({ providerId, baseUrl: null })
    expect(cleared.baseUrl).toBeNull()
    const clearedRow = await db.dataSource.query<{ base_url: string | null }[]>(
      'SELECT base_url FROM ai_providers WHERE id = $1',
      [providerId],
    )
    expect(clearedRow[0].base_url).toBeNull()

    // apiKey = '' → 清空（hasApiKey=false、hint=null）；没密钥时同步报 3403 且说明清楚
    const noKey = await service.updateProvider({ providerId, apiKey: '' })
    expect((noKey as { hasApiKey: boolean }).hasApiKey).toBe(false)
    expect(noKey.apiKeyHint).toBeNull()
    await expect(service.syncProvider({ providerId })).rejects.toMatchObject({ code: 3403 })
    await expect(service.syncProvider({ providerId })).rejects.toThrow(/未配置密钥/)

    // apiKey 有值 → 加密覆盖（提示跟着变）
    const rekeyed = await service.updateProvider({ providerId, apiKey: 'sk-other-key-zzzz' })
    expect(rekeyed.apiKeyHint).toBe('sk-…zzzz')
    expect(await cipherOf()).not.toBe(before)

    // name / slug 唯一冲突 → 可读错误（4001），而不是数据库 23505
    const second = await service.createProvider({
      name: 'Second Gateway',
      kind: AiProviderKind.OpenaiCompatible,
      baseUrl: mock.baseURL,
      apiKey: TEST_API_KEY,
    })
    createdProviderIds.push(second.id)
    await expect(
      service.updateProvider({ providerId, name: 'Second Gateway' }),
    ).rejects.toMatchObject({ code: 4001 })
    await expect(
      service.updateProvider({ providerId, slug: 'second-gateway' }),
    ).rejects.toMatchObject({ code: 4001 })

    // 复原：后续用例仍按原密钥 / 原地址断言
    const restored = await service.updateProvider({
      providerId,
      baseUrl: mock.baseURL,
      apiKey: TEST_API_KEY,
    })
    expect(restored.apiKeyHint).toBe('sk-…abcd')
    // 第二个供应商建完即删，避免影响后续 listAvailable 断言
    await service.removeProvider({ providerId: second.id })
  })

  it('⑩ 供应商禁用后：不在可选用清单里，运行时回落 3406', async () => {
    const providerId = createdProviderIds[0]
    await service.updateProvider({ providerId, enabled: false })

    await expect(service.listAvailable()).resolves.toEqual({ models: [], defaultModelId: null })
    await expect(service.resolveForRuntime()).rejects.toMatchObject({ code: 3406 })

    await service.updateProvider({ providerId, enabled: true })
  })

  it('⑪ 删供应商：供应商与其下模型一起软删，运行时可选用清单变空', async () => {
    const providerId = createdProviderIds[0]
    await service.removeProvider({ providerId })

    const providerRows = await db.dataSource.query<{ deleted_at: Date | null }[]>(
      'SELECT deleted_at FROM ai_providers WHERE id = $1',
      [providerId],
    )
    const modelRows = await db.dataSource.query<{ deleted_at: Date | null }[]>(
      'SELECT deleted_at FROM ai_models WHERE provider_id = $1',
      [providerId],
    )
    expect(providerRows[0].deleted_at).not.toBeNull()
    expect(modelRows.length).toBe(2)
    expect(modelRows.every((row) => row.deleted_at !== null)).toBe(true)
    await expect(service.listAvailable()).resolves.toEqual({ models: [], defaultModelId: null })
    expect(await providerIdsOf()).not.toContain(providerId)
  })
})
