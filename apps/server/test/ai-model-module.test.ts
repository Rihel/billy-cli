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
  DEFAULT_PROVIDER_BASE_URLS,
  PROVIDER_ENDPOINTS,
  hintOf,
  listProviderModels,
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

  it('③ 建供应商：slug 由名称生成；密钥**明文入库**，对外只回 hint / hasApiKey', async () => {
    const created = await service.createProvider({
      name: 'My Mock Gateway',
      // mock 服务就是通用 OpenAI 兼容形态：用国内厂商 kind + 显式 baseUrl 指向 mock，
      // 验证"厂商 kind 走通用 adapter，且显式地址覆盖厂商默认地址"
      kind: AiProviderKind.Deepseek,
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

    // 明文入库（2026-10-01 决定）：库里直接是原文，且**没有**提示列（提示串读取时派生）
    const rows = await db.dataSource.query<{ api_key: string | null }[]>(
      'SELECT api_key FROM ai_providers WHERE id = $1',
      [created.id],
    )
    expect(rows[0].api_key).toBe(TEST_API_KEY)
  })

  it('③b 名称里没有可用 ASCII 字符 → slug 无法生成，明确报错（4001）', async () => {
    await expect(
      service.createProvider({
        name: '纯中文名称',
        kind: AiProviderKind.Deepseek,
        baseUrl: mock.baseURL,
        apiKey: TEST_API_KEY,
      }),
    ).rejects.toMatchObject({ code: 4001 })
  })

  it('④ 同步：落模型明细，供应商原始 JSON 全量进 raw；窗口字段拿不到就是 null', async () => {
    const providerId = createdProviderIds[0]
    const result = await service.syncProvider({ providerId })

    expect(result).toMatchObject({ created: 3, updated: 0, unchanged: 0, missing: 0, total: 3 })
    // 同步确实打了 mock 的 GET /models，且带 Bearer 密钥
    expect(mock.listRequests.at(-1)?.url).toContain('/models')
    expect(mock.listRequests.at(-1)?.authorization).toBe(`Bearer ${TEST_API_KEY}`)

    const page = await service.listModels({ providerId, page: 1, size: 10 })
    expect(page.total).toBe(3)
    expect(page.items.map((item) => item.modelKey)).toEqual([
      'mock-chat',
      'mock-reasoner',
      'mock-vision',
    ])

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
    expect((detail as { modelCount: number }).modelCount).toBe(3)
  })

  it('④b 规格字段：供应商给了窗口 / 输出上限 / 展示名 → 同步后必须落库', async () => {
    const providerId = createdProviderIds[0]
    const page = await service.listModels({ providerId, page: 1, size: 10 })
    const withSpecs = page.items.find((item) => item.modelKey === 'mock-vision')!

    /**
     * 为什么这条必须钉在集成层：上下文窗口是上下文裁剪与压缩策略的**唯一输入**
     * （`ai/runtime/context.service.ts` 拿它算触发线）。解析出来却没落库，
     * 症状不是报错，而是静默退回 32K 兜底窗口并打一条 warn —— 单测层看不出来。
     */
    expect(withSpecs.contextWindow).toBe(131_072)
    expect(withSpecs.maxOutputTokens).toBe(8_192)
    expect(withSpecs.displayName).toBe('Mock Vision')
    // 明确声明 `input_modalities: ['text','image']` 必须认成"已声明"，不能落成"未声明"
    expect(withSpecs.inputModalities).toEqual(['text', 'image'])
    expect(withSpecs.outputModalities).toEqual(['text'])
  })

  it('⑤ 重复同步幂等：不插重复行，全部记为 unchanged', async () => {
    const providerId = createdProviderIds[0]
    const again = await service.syncProvider({ providerId })
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 3, total: 3 })

    const count = await models.countModels(providerId)
    expect(count).toBe(3)
  })

  it('⑤b 模态与类型：供应商给了就落库，没给就是**未声明**（不编造）', async () => {
    const providerId = createdProviderIds[0]
    const page = await service.listModels({ providerId, page: 1, size: 10 })
    const withModalities = page.items.find((item) => item.modelKey === 'mock-vision')!
    const without = page.items.find((item) => item.modelKey === 'mock-chat')!

    // 供应商给了 `architecture.input_modalities` → 原样归一落库
    expect(withModalities.inputModalities).toEqual(['text', 'image'])
    expect(withModalities.outputModalities).toEqual(['text'])

    // 没给 → null（"未声明"），**不是空数组**（"明确什么都不支持"是另一件事）
    expect(without.inputModalities).toBeNull()
    expect(without.outputModalities).toBeNull()
    // 类型认不出就是 unknown（不猜成 chat：猜错会让不能对话的模型出现在选择器里）
    expect(without.mode).toBe('unknown')
  })

  it('⑤c 人工填的模态**不被同步覆盖**（供应商没给时保留库里的值）', async () => {
    const providerId = createdProviderIds[0]
    const page = await service.listModels({ providerId, page: 1, size: 10 })
    const target = page.items.find((item) => item.modelKey === 'mock-chat')!

    // 人在后台填了"支持图片"（国内厂商多数不给这项，只能手填）
    await service.updateModel({ modelId: target.id, inputModalities: ['text', 'image'] })
    expect((await models.findById(target.id))?.inputModalities).toEqual(['text', 'image'])

    // 再同步一次：供应商没给模态 → 保留人工填的（否则附件能力会悄悄退回"未声明"）
    await service.syncProvider({ providerId })
    expect((await models.findById(target.id))?.inputModalities).toEqual(['text', 'image'])
  })

  it('⑤d 显式传 null 可以撤成"未声明"', async () => {
    const providerId = createdProviderIds[0]
    const page = await service.listModels({ providerId, page: 1, size: 10 })
    const target = page.items.find((item) => item.modelKey === 'mock-chat')!

    await service.updateModel({ modelId: target.id, inputModalities: null })
    expect((await models.findById(target.id))?.inputModalities).toBeNull()
  })

  it('⑤e 可选模型清单**按类型过滤**：embedding 不列，未声明的照列', async () => {
    const providerId = createdProviderIds[0]
    // 新建一个明确是 embedding 的模型（**不动共享的 mock-* 行**：后面的用例还要用它们）
    const embedding = await service.createModel({
      providerId,
      modelKey: 'mock-embedding',
      mode: 'embedding',
    })

    const available = await service.listAvailable()
    const keys = available.models.map((model) => model.modelKey)
    expect(keys).not.toContain('mock-embedding')
    // 未声明类型的照列（国内厂商多数不给类型，按类型过滤会把正常模型也挡住）
    expect(keys).toContain('mock-chat')

    await service.removeModel({ modelId: embedding.id })
  })

  it('⑤f 手工填的上下文窗口**不被同步清空**（供应商没给时保留人的值）', async () => {
    const providerId = createdProviderIds[0]
    const page = await service.listModels({ providerId, page: 1, size: 10 })
    // mock-chat 在 mock 清单里没有窗口字段（多数厂商还是老形态，只能人填）
    const target = page.items.find((item) => item.modelKey === 'mock-chat')!

    await service.updateModel({
      modelId: target.id,
      contextWindow: 65_536,
      maxOutputTokens: 4_096,
    })
    expect((await models.findById(target.id))?.contextWindow).toBe(65_536)

    // 再同步一次：供应商没给窗口 → 保留人工填的（否则每次同步都把人的判断抹掉）
    await service.syncProvider({ providerId })
    const after = await models.findById(target.id)
    expect(after?.contextWindow).toBe(65_536)
    expect(after?.maxOutputTokens).toBe(4_096)

    // 撤回去：⑦ 要断言"供应商没给窗口 → resolveForRuntime 拿到 null"，别把它带成 65536
    await service.updateModel({
      modelId: target.id,
      contextWindow: null,
      maxOutputTokens: null,
    })
  })

  it('⑥ 同步不覆盖启停：手工禁用某模型后再同步，enabled 保持不变，也没有重复行', async () => {
    const providerId = createdProviderIds[0]
    const page = await service.listModels({ providerId, page: 1, size: 10 })
    const target = page.items.find((item) => item.modelKey === 'mock-reasoner')!

    await service.updateModel({ modelId: target.id, enabled: false })
    await service.syncProvider({ providerId })

    const after = await models.findById(target.id)
    expect(after?.enabled).toBe(false)
    expect(await models.countModels(providerId)).toBe(3)
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

    // 清单里不含被禁用的那个（其余照列）
    const available = await service.listAvailable()
    const keys = available.models.map((item) => item.modelKey)
    expect(keys).not.toContain('mock-reasoner')
    expect(keys).toContain('mock-chat')
    expect(available.models[0].providerSlug).toBe((await providers.findById(providerId))!.slug)
    expect(available.defaultModelId).toBe(resolved.id)
  })

  it('⑧ provider/test：连通性测试只测不落库，回来的是模型数', async () => {
    const result = await service.testProvider({
      kind: AiProviderKind.Deepseek,
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
    const keyOf = async (): Promise<string | null> => {
      const rows = await db.dataSource.query<{ api_key: string | null }[]>(
        'SELECT api_key FROM ai_providers WHERE id = $1',
        [providerId],
      )
      return rows[0].api_key
    }
    const before = await keyOf()

    // apiKey 省略 → 不改（库里的明文与派生的提示都不动）；baseUrl 给字符串 → 覆盖
    const kept = await service.updateProvider({ providerId, baseUrl: mock.baseURL })
    expect(kept.apiKeyHint).toBe('sk-…abcd')
    expect(await keyOf()).toBe(before)

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

    // apiKey 有值 → 明文覆盖（提示跟着变）
    const rekeyed = await service.updateProvider({ providerId, apiKey: 'sk-other-key-zzzz' })
    expect(rekeyed.apiKeyHint).toBe('sk-…zzzz')
    expect(await keyOf()).not.toBe(before)

    // name / slug 唯一冲突 → 可读错误（4001），而不是数据库 23505
    const second = await service.createProvider({
      name: 'Second Gateway',
      kind: AiProviderKind.Moonshot,
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
    // 同步落了三行（不写死总数：前面的用例可能临时建过模型）
    expect(modelRows.length).toBeGreaterThanOrEqual(3)
    expect(modelRows.every((row) => row.deleted_at !== null)).toBe(true)
    await expect(service.listAvailable()).resolves.toEqual({ models: [], defaultModelId: null })
    expect(await providerIdsOf()).not.toContain(providerId)
  })

  it('⑫ 不支持列模型的厂商（讯飞星火）：不发请求，直接给明确中文提示', async () => {
    await expect(
      listProviderModels({ kind: AiProviderKind.Spark, apiKey: 'sk-test' }),
    ).rejects.toMatchObject({ code: 3403 })
    await expect(
      listProviderModels({ kind: AiProviderKind.Spark, apiKey: 'sk-test' }),
    ).rejects.toThrow(/该供应商不支持自动拉取模型明细，请手工新增模型/)
  })

  it('⑬ 未知 kind / 没有默认地址：发请求前就拦住并明确报错', async () => {
    await expect(
      listProviderModels({ kind: 'not-a-vendor', apiKey: 'sk-test' }),
    ).rejects.toThrow(/不支持的供应商类型/)

    // openai-compatible 是"协议形态兜底"，没有官方默认地址：baseUrl 留空必须手填
    await expect(
      listProviderModels({ kind: AiProviderKind.OpenaiCompatible, apiKey: 'sk-test' }),
    ).rejects.toThrow(/必须配置 baseUrl/)
  })

  it('⑭ 默认地址表：国内厂商带兼容路径，兜底项刻意没有默认地址', () => {
    expect(DEFAULT_PROVIDER_BASE_URLS[AiProviderKind.Deepseek]).toBe('https://api.deepseek.com')
    // 百炼 / 火山方舟 / 智谱的兼容路径都不是 /v1
    expect(PROVIDER_ENDPOINTS[AiProviderKind.Dashscope].baseUrl).toContain('/compatible-mode/v1')
    expect(PROVIDER_ENDPOINTS[AiProviderKind.Volcengine].baseUrl).toContain('/api/v3')
    expect(PROVIDER_ENDPOINTS[AiProviderKind.Zhipu].baseUrl).toContain('/api/paas/v4')
    expect(DEFAULT_PROVIDER_BASE_URLS[AiProviderKind.OpenaiCompatible]).toBeUndefined()
    // 只有"确认不支持列模型"的那一家在表里被标 false
    expect(PROVIDER_ENDPOINTS[AiProviderKind.Spark].supportsModelList).toBe(false)
  })
})
