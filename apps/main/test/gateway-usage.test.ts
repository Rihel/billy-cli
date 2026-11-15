import 'dotenv/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Db, type AppLogger } from '@repo/kits'
import { AiModelEntity, AiProviderEntity, ModelGatewayUsageEntity } from '@repo/db'
import { GatewayUsageService } from '../src/modules/ai-usage/gateway-usage.service.js'

const silentLogger = {
  setContext: () => undefined,
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as AppLogger

let db: Db
let service: GatewayUsageService

const REQUEST_PREFIX = 'test-gw-usage-'
const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)

beforeAll(async () => {
  db = new Db(
    {
      url: process.env.DB_URL!,
      sync: false,
      entities: [ModelGatewayUsageEntity, AiProviderEntity, AiModelEntity],
    } as never,
    silentLogger,
  )
  await db.onApplicationBootstrap()
  if (!db.dataSource.isInitialized) throw new Error('数据库初始化失败')
  await db.dataSource.query('DELETE FROM model_gateway_usage WHERE request_id LIKE $1', [
    `${REQUEST_PREFIX}%`,
  ])
  service = new GatewayUsageService(db)
})

afterAll(async () => {
  await db.dataSource.query('DELETE FROM model_gateway_usage WHERE request_id LIKE $1', [
    `${REQUEST_PREFIX}%`,
  ])
  await db.close()
})

describe('GatewayUsageService', () => {
  it('明细 / 汇总按调用口径统计（含失败尝试与缺失 usage）', async () => {
    const repo = db.getRepository(ModelGatewayUsageEntity)
    await repo.save([
      repo.create({
        requestId: `${REQUEST_PREFIX}1`,
        attempt: 1,
        runId: `${REQUEST_PREFIX}run-1`,
        conversationId: 'conv-1',
        providerId: 'prov-test',
        modelId: 'model-test',
        status: 'success',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costMicros: 25,
      }),
      repo.create({
        requestId: `${REQUEST_PREFIX}2`,
        attempt: 1,
        runId: `${REQUEST_PREFIX}run-1`,
        conversationId: 'conv-1',
        providerId: 'prov-test',
        modelId: 'model-test',
        status: 'error',
        httpStatus: 429,
        totalTokens: null,
        usageMissing: true,
      }),
    ])

    const list = await service.list({ page: 1, size: 10, from: today, to: today })
    expect(list.total).toBeGreaterThanOrEqual(2)
    const ours = list.items.filter((item) => item.requestId.startsWith(REQUEST_PREFIX))
    expect(ours).toHaveLength(2)
    expect(ours.some((item) => item.status === 'error')).toBe(true)

    const summary = await service.summary({ from: today, to: today })
    expect(summary.totals.calls).toBeGreaterThanOrEqual(2)
    expect(summary.totals.totalTokens).toBeGreaterThanOrEqual(15)
    expect(summary.byModel.some((item) => item.key === 'model-test')).toBe(true)
    expect(summary.byProvider.some((item) => item.key === 'prov-test')).toBe(true)
  })

  it('对账：没有对应 run 的调用账记为孤儿，不抛错', async () => {
    const result = await service.reconcile({
      page: 1,
      size: 10,
      from: today,
      to: today,
      onlyDiff: true,
    })
    expect(result.orphanRuns).toBeGreaterThanOrEqual(1)
    expect(result.items.some((item) => item.runId === `${REQUEST_PREFIX}run-1`)).toBe(true)
  })
})
