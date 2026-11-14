import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { ToolRegistry } from '../src/modules/ai/core/tools/tool.registry.js'
import { expandToolSelectors } from '../src/modules/ai/core/tools/tool-selector.js'
import type { ToolSelectorEntry } from '../src/modules/ai/core/tools/tool-selector.js'
import type { ToolSpec } from '../src/modules/ai/core/tools/tools.types.js'
import { EventDeclTool } from '../src/modules/ai/tools/tool-event-testkit.js'
import { buildToolStackDeps, silentLogger } from './helpers/ai-tool-stack.js'

/**
 * 工具选择器（agent 授权清单里的 `*` / `category` / `connector` / 具体 key）。
 *
 * 测两件事：
 * 1. **展开**：四条分支、去重、顺序、连接器零命中（连接器是运行期同步的，启动时可能还没有）；
 * 2. **注册机接线**：具体 key 不存在要在装配期报错；作用域过滤与子 agent 工具面上限。
 */

const entries: ToolSelectorEntry[] = [
  { key: 'plan-create', category: 'core' },
  { key: 'bash', category: 'core' },
  {
    key: 'c-local-query',
    category: 'connector',
    connectorKey: 'local',
    connectorToolName: 'query',
  },
  {
    key: 'c-local-list',
    category: 'connector',
    connectorKey: 'local',
    connectorToolName: 'list-tables',
  },
  { key: 'c-prod-query', category: 'connector', connectorKey: 'prod', connectorToolName: 'query' },
]

describe('工具选择器：展开', () => {
  it('`*` 展开全部（顺序按注册顺序）', () => {
    expect(expandToolSelectors(['*'], entries)).toEqual(entries.map((entry) => entry.key))
  })

  it('具体 key 原样返回（存在性交给注册机判）', () => {
    expect(expandToolSelectors(['plan-create'], entries)).toEqual(['plan-create'])
  })

  it('按类别选', () => {
    expect(expandToolSelectors([{ category: 'connector' }], entries)).toEqual([
      'c-local-query',
      'c-local-list',
      'c-prod-query',
    ])
  })

  it('按连接器选：实例的全部工具', () => {
    expect(expandToolSelectors([{ connector: 'local' }], entries)).toEqual([
      'c-local-query',
      'c-local-list',
    ])
  })

  it('按连接器选：精确到一个工具（用接入方原名，不做 key 反解）', () => {
    expect(expandToolSelectors([{ connector: 'local', tool: 'query' }], entries)).toEqual([
      'c-local-query',
    ])
  })

  it('连接器零命中不是错误（运行期才同步进来）', () => {
    expect(expandToolSelectors([{ connector: 'not-yet' }], entries)).toEqual([])
  })

  it('混写去重且保持首次出现的顺序', () => {
    expect(
      expandToolSelectors(
        ['c-local-query', { connector: 'local' }, 'plan-create', 'plan-create'],
        entries,
      ),
    ).toEqual(['c-local-query', 'c-local-list', 'plan-create'])
  })

  it('写错的类别 / 连接器 key / 空选择器当场报错', () => {
    expect(() => expandToolSelectors([''], entries)).toThrowError(/不能为空/)
    expect(() => expandToolSelectors(['plan create'], entries)).toThrowError(/不能包含空白/)
    expect(() => expandToolSelectors([{ category: 'nope' as never }], entries)).toThrowError(
      /未知的工具类别/,
    )
    expect(() => expandToolSelectors([{ connector: 'Bad Key' }], entries)).toThrowError(
      /连接器实例 key 不合法/,
    )
    expect(() => expandToolSelectors([{ connector: 'local', tool: '  ' }], entries)).toThrowError(
      /工具名不能为空/,
    )
    expect(() =>
      expandToolSelectors([{ category: 'core', connector: 'local' } as never], entries),
    ).toThrowError(/只能有 category 或 connector/)
  })
})

const connectorSpec: ToolSpec = {
  key: 'c-local-query',
  title: '查表',
  description: '连接器产出的只读查询工具',
  category: 'connector',
  params: z.object({}),
  config: z.object({}),
  events: [],
  connector: { id: 'conn-1', key: 'local', toolName: 'query' },
  scope: 'admin',
  exec: async () => ({}),
}

const buildRegistry = () => {
  const deps = buildToolStackDeps()
  const gateway = new ToolGateway(deps.config, silentLogger as never, deps.plugins, deps.clock)
  const registry = new ToolRegistry([new EventDeclTool()], gateway, deps.config)
  registry.registerDynamic('conn-1', [connectorSpec])
  return { deps, registry }
}

describe('工具选择器：注册机接线', () => {
  it('具体 key 不存在 → 装配期（describe）就报错', () => {
    const { registry } = buildRegistry()
    expect(() => registry.describe(['not-registered'])).toThrowError(/未知的工具 key/)
  })

  it('装配期按身份过滤作用域：前台用户看不到 admin 工具', async () => {
    const { deps, registry } = buildRegistry()
    deps.source.set('test-event-decl', { scope: 'admin' })
    const keys = registry.expand(['*'])
    expect(await registry.authorized(keys, { isAdmin: false, rootAgentKey: 'assistant' })).toEqual(
      [],
    )
    expect(await registry.authorized(keys, { isAdmin: true, rootAgentKey: 'assistant' })).toEqual(
      keys,
    )
  })

  it('`agent` 作用域按根 agent 判（子 agent 沿用父的 key）', async () => {
    const { deps, registry } = buildRegistry()
    deps.source.set('test-event-decl', { scope: 'agent', allowedAgents: ['support'] })
    expect(
      await registry.authorized(['test-event-decl'], { isAdmin: true, rootAgentKey: 'support' }),
    ).toEqual(['test-event-decl'])
    expect(
      await registry.authorized(['test-event-decl'], { isAdmin: true, rootAgentKey: 'assistant' }),
    ).toEqual([])
  })

  it('子 agent 的工具面 = 父授权 ∩ 全部 − 委派类', () => {
    const { registry } = buildRegistry()
    expect([...registry.childToolbox([{ category: 'core' }]).keys()]).toEqual(['test-event-decl'])
    expect([...registry.childToolbox(['*']).keys()]).toEqual(
      expect.arrayContaining(['test-event-decl', 'c-local-query']),
    )
    expect([...registry.childToolbox([]).keys()]).toEqual([])
  })
})
