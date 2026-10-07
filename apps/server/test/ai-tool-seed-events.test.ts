import 'dotenv/config'
import { Db } from '@repo/kits'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AiToolEntity } from '../src/database/entities/ai-tool-entity.js'
import { ToolConfigRepository } from '../src/modules/ai/core/tools/tool.config.repository.js'
import { buildToolSpecs } from '../src/modules/ai/core/tools/tool.class.js'
import type { AnyToolSpec } from '../src/modules/ai/core/tools/tools.types.js'
import { EventDeclTool, NoEventTool } from '../src/modules/ai/tools/tool-event-testkit.js'
import { testLogger } from './helpers/logger.js'

/**
 * 事件声明的**入库镜像**（设计 §5.17）：真实数据库，验启动期种子同步那一列。
 *
 * 口径与 `param_schema` 完全一致：**基础信息留在代码、启动期全量覆盖写入**，
 * config / limits / secrets 一律不碰。所以这里测三件事：
 * 1. 首次同步把归一化后的声明写进 `ai_tools.events`（含 payload 的 JSON Schema 镜像）；
 * 2. 跑两次结果一致（幂等），改动代码声明后启动即刷新；
 * 3. 没有声明事件的工具写空数组（不是 NULL），读出来仍是"没有事件"。
 *
 * 前置：`apps/server/.env` 的 DB_URL 指向可用库，且已执行迁移（含 `events` 列）。
 */

/** 测试自造的行（结束时物理删掉，不污染开发库与后台页） */
const TEST_KEYS = ['test-event-decl', 'test-no-event']

let db: Db
let repository: ToolConfigRepository

const specOf = (group: object, key: string): AnyToolSpec => {
  const spec = buildToolSpecs(group).find((item) => item.key === key)
  if (!spec) throw new Error(`测试工具组没有交出工具 ${key}`)
  return spec as AnyToolSpec
}

const rowOf = async (toolKey: string) =>
  db.dataSource.query<{ events: unknown }[]>('SELECT events FROM ai_tools WHERE tool_key = $1', [toolKey])

beforeAll(async () => {
  db = new Db(
    { url: process.env.DB_URL!, sync: false, entities: [AiToolEntity] } as never,
    testLogger(),
  )
  await db.onApplicationBootstrap()
  repository = new ToolConfigRepository(db, testLogger())
  // 上一轮残留（测试中途失败时会有）先清掉：种子同步按 key 幂等，但断言要的是干净起点
  await db.dataSource.query('DELETE FROM ai_tools WHERE tool_key = ANY($1)', [TEST_KEYS])
})

afterAll(async () => {
  await db.dataSource.query('DELETE FROM ai_tools WHERE tool_key = ANY($1)', [TEST_KEYS])
  await db.onApplicationShutdown()
})

describe('事件声明入库镜像（真实库）', () => {
  it('首次同步：events 落成归一化后的声明（mode 默认值 + payloadSchema）', async () => {
    const result = await repository.upsertSeed(specOf(new EventDeclTool(), 'test-event-decl'))
    expect(result).toBe('created')

    const events = (await rowOf('test-event-decl'))[0].events as Array<Record<string, unknown>>
    expect(events.map((event) => [event.name, event.mode])).toEqual([
      ['progress', 'state'],
      ['log-line', 'stream'],
      ['stage', 'state'],
    ])
    expect(events[0].payloadSchema).toMatchObject({
      type: 'object',
      properties: { percent: { type: 'number' } },
    })
    expect(events[1].payloadSchema).toBeNull()
  })

  it('再同步一次：结果一致（幂等），事件不会被追加成两份', async () => {
    await repository.upsertSeed(specOf(new EventDeclTool(), 'test-event-decl'))
    const events = (await rowOf('test-event-decl'))[0].events as unknown[]
    expect(events).toHaveLength(3)
  })

  it('代码声明改了：下次同步**全量覆盖**（库里那份是只读镜像，人工改不了）', async () => {
    await db.dataSource.query(`UPDATE ai_tools SET events = '[{"name":"旧的"}]'::jsonb WHERE tool_key = $1`, [
      'test-event-decl',
    ])
    await repository.upsertSeed(specOf(new EventDeclTool(), 'test-event-decl'))
    const events = (await rowOf('test-event-decl'))[0].events as Array<Record<string, unknown>>
    expect(events.map((event) => event.name)).toEqual(['progress', 'log-line', 'stage'])
  })

  it('没有声明事件的工具：写空数组而不是 NULL', async () => {
    await repository.upsertSeed(specOf(new NoEventTool(), 'test-no-event'))
    const row = await rowOf('test-no-event')
    expect(row[0].events).toEqual([])
  })

  it('配置行读出来带上 events（管理台与参数定义同一条读取链路）', async () => {
    const loaded = await repository.load(specOf(new EventDeclTool(), 'test-event-decl'))
    expect(loaded?.events?.map((event) => event.name)).toEqual(['progress', 'log-line', 'stage'])
  })
})
