import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  connectorToolKey,
  isValidConnectorKey,
  normalizeKeyPart,
} from '../src/modules/ai/connectors/connector.keys.js'
import { assertReadOnlySql, sqlLeadKeyword, stripSqlNoise } from '../src/modules/ai/connectors/sql.policy.js'
import {
  inputSchemaToZod,
  toConnectorToolSpec,
} from '../src/modules/ai/connectors/connector.tool.factory.js'
import type { ConnectorDriver } from '../src/modules/ai/connectors/connector.types.js'
import { CONNECTOR_CATALOG } from '../src/modules/ai/connectors/connector.catalog.js'
import { ConnectorGuardPlugin } from '../src/modules/ai/connectors/connector.guard.plugin.js'
import type { ConnectorStateSource } from '../src/modules/ai/connectors/connector.state.js'
import { PrecheckPlugin } from '../src/modules/ai/core/tools/plugins/precheck.plugin.js'
import { hintOf } from '../src/modules/ai-model/secret-hint.js'
import { ToolDeniedError } from '../src/modules/ai/core/tools/tools.types.js'

/**
 * 连接器的纯逻辑测试（设计 `docs/design/ai-connector.md` §3.5 / §3.11）。
 *
 * 只测不起服务也能验的部分：key 规则、只读 SQL 判定、能力 → 工具。
 * 注册机动态段与同步流程要靠 DB / 驱动联调，放在后续的集成测试里。
 */

describe('connector keys', () => {
  it('归一化：小写、非法字符换连字符、去首尾连字符', () => {
    expect(normalizeKeyPart('List Tables')).toBe('list-tables')
    expect(normalizeKeyPart('a__b..c')).toBe('a-b-c')
    expect(normalizeKeyPart('--x--')).toBe('x')
    expect(normalizeKeyPart('中文')).toBe('')
  })

  it('工具 key：带实例前缀、长度不超过 64', () => {
    expect(connectorToolKey('pg-main', 'list_tables')).toBe('c-pg-main-list-tables')
    const long = connectorToolKey('pg-main', 'x'.repeat(100))
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long.startsWith('c-pg-main-')).toBe(true)
  })

  it('实例 key 校验与 schema 同口径', () => {
    expect(isValidConnectorKey('pg-main')).toBe(true)
    expect(isValidConnectorKey('PG')).toBe(false)
    expect(isValidConnectorKey('a--b')).toBe(false)
    expect(isValidConnectorKey('x'.repeat(33))).toBe(false)
  })
})

describe('只读 SQL 判定', () => {
  it('放行单条只读语句', () => {
    expect(() => assertReadOnlySql('select * from users')).not.toThrow()
    expect(() => assertReadOnlySql('WITH t AS (select 1) select * from t')).not.toThrow()
    expect(() => assertReadOnlySql('EXPLAIN select 1')).not.toThrow()
    expect(() => assertReadOnlySql('select 1;')).not.toThrow()
  })

  it('拒绝写语句', () => {
    expect(() => assertReadOnlySql('update users set name = 1')).toThrow(ToolDeniedError)
    expect(() => assertReadOnlySql('delete from users')).toThrow(ToolDeniedError)
    expect(() => assertReadOnlySql('drop table users')).toThrow(ToolDeniedError)
  })

  it('拒绝多语句', () => {
    expect(() => assertReadOnlySql('select 1; drop table users')).toThrow(ToolDeniedError)
  })

  it('注释与字符串里的关键字不影响判定', () => {
    expect(stripSqlNoise("select '--not a comment' as x")).not.toContain('--not')
    expect(sqlLeadKeyword('-- 说明\nselect 1')).toBe('select')
    expect(() => assertReadOnlySql("select ';' as x")).not.toThrow()
  })

  it('空语句拒绝', () => {
    expect(() => assertReadOnlySql('   ')).toThrow(ToolDeniedError)
  })
})

describe('型号默认值', () => {
  it('SQL 型号必须带 dialect（否则会拿 PG 协议去连 MySQL 端口）', () => {
    const sqlEntries = CONNECTOR_CATALOG.filter((entry) => entry.driver === 'sql')
    expect(sqlEntries.length).toBeGreaterThan(0)
    for (const entry of sqlEntries) {
      expect(entry.defaults?.dialect).toBe(entry.kind === 'mysql' ? 'mysql' : 'postgres')
      expect(entry.defaults?.port).toBeTypeOf('number')
    }
  })

  it('Redis 型号带默认端口', () => {
    const redis = CONNECTOR_CATALOG.find((entry) => entry.kind === 'redis')
    expect(redis?.defaults?.port).toBe(6379)
  })
})

describe('能力 → 工具', () => {
  const driver: ConnectorDriver = {
    kind: 'fake',
    transport: 'db',
    config: z.object({}),
    secrets: [{ key: 'password', label: '密码', type: 'password', secret: true, required: true }],
    auth: { base: 'secret', subject: 'none' },
    describe: async () => [],
    invoke: async () => ({ ok: true }),
    probe: async () => ({ ok: true }),
  }

  it('key / 来源 / 作用域 / 密钥字段都按约定', () => {
    const spec = toConnectorToolSpec(
      { id: 'c1', key: 'pg-main', name: '主库' },
      driver,
      {
        kind: 'tool',
        name: 'query',
        title: '只读查询',
        description: '跑一条只读 SQL',
        inputSchema: {
          type: 'object',
          properties: { sql: { type: 'string' } },
          required: ['sql'],
        },
        risk: 'read',
      },
      { instanceId: 'c1', key: 'pg-main', config: {}, secrets: { password: 'x' } },
    )

    expect(spec.key).toBe('c-pg-main-query')
    expect(spec.category).toBe('connector')
    // 连接器工具默认只给管理员对话
    expect(spec.scope).toBe('admin')
    expect(spec.description).toContain('主库')
    expect(spec.secretFields?.[0]).toEqual({ name: 'password', label: '密码', required: true })
    // 入参 schema 真能校验
    expect(spec.params.safeParse({ sql: 'select 1' }).success).toBe(true)
    expect(spec.params.safeParse({}).success).toBe(false)
  })

  it('入参 schema 转不动时降级为任意对象', () => {
    const schema = inputSchemaToZod({ type: 'nonsense' })
    expect(schema.safeParse({ any: 1 }).success).toBe(true)
  })
})

describe('连接器总闸插件', () => {
  const makeCtx = (settings: Record<string, unknown>) =>
    ({
      toolKey: 'c-local-query',
      spec: {
        key: 'c-local-query',
        connector: { id: 'c1', key: 'local' },
        secretFields: [{ name: 'password', label: '密码', required: true }],
      },
      settings,
    }) as never

  const source = (
    state: Awaited<ReturnType<ConnectorStateSource['stateOf']>>,
  ): ConnectorStateSource => ({ stateOf: async () => state })

  it('把实例密钥嫁接进设置：precheck 不再误报「缺少密码」', async () => {
    const guard = new ConnectorGuardPlugin(
      source({ enabled: true, missingSecret: false, name: '本地 mysql', secrets: { password: 'p@ss' } }),
    )
    const settings = { secret: () => null, secretHint: () => null }
    const ctx = makeCtx(settings)

    expect(await guard.pre(ctx)).toBeUndefined()
    expect(settings.secret('password' as never)).toBe('p@ss')
    expect(settings.secretHint('password' as never)).toBe(hintOf('p@ss'))
    // 嫁接之后，前置检查看到的密钥是齐的
    expect(await new PrecheckPlugin().pre(ctx)).toBeUndefined()
  })

  it('连接器停用 → disabled 结论', async () => {
    const guard = new ConnectorGuardPlugin(
      source({ enabled: false, missingSecret: false, name: '本地 mysql', secrets: {} }),
    )
    const outcome = await guard.pre(makeCtx({ secret: () => null, secretHint: () => null }))
    expect(outcome).toMatchObject({ ok: false, reason: 'disabled' })
  })

  it('缺必填密钥 → precheck-failed 结论', async () => {
    const guard = new ConnectorGuardPlugin(
      source({ enabled: true, missingSecret: true, name: '本地 mysql', secrets: {} }),
    )
    const outcome = await guard.pre(makeCtx({ secret: () => null, secretHint: () => null }))
    expect(outcome).toMatchObject({ ok: false, reason: 'precheck-failed' })
  })
})
