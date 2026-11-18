import { describe, expect, it } from 'vitest'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { ToolRegistry } from '../src/modules/ai/core/tools/tool.registry.js'
import { EXTERNAL_TOOLS, expandToolSelectors } from '../src/modules/ai/core/tools/tool-selector.js'
import type { ToolSelectorEntry } from '../src/modules/ai/core/tools/tool-selector.js'
import { EventDeclTool } from '../src/modules/ai/tools/tool-event-testkit.js'
import { buildToolStackDeps, silentLogger } from './helpers/ai-tool-stack.js'

/**
 * 工具选择器（agent 授权清单里的 `*` / `category` / 具体 key）。
 *
 * 测两件事：
 * 1. **展开**：三条分支、去重、顺序；
 * 2. **注册机接线**：具体 key 不存在要在装配期报错；作用域过滤与子 agent 工具面上限。
 */

const entries: ToolSelectorEntry[] = [
  { key: 'plan-create', category: 'core' },
  { key: 'bash', category: 'core' },
  { key: 'query-db', category: 'business' },
]

describe('工具选择器：展开', () => {
  it('`*` 展开全部（顺序按注册顺序）', () => {
    expect(expandToolSelectors(['*'], entries)).toEqual(entries.map((entry) => entry.key))
  })

  it('具体 key 原样返回（存在性交给注册机判）', () => {
    expect(expandToolSelectors(['plan-create'], entries)).toEqual(['plan-create'])
  })

  it('按类别选', () => {
    expect(expandToolSelectors([{ category: 'core' }], entries)).toEqual(['plan-create', 'bash'])
    expect(expandToolSelectors([{ category: 'business' }], entries)).toEqual(['query-db'])
    expect(expandToolSelectors([{ category: 'runtime' }], entries)).toEqual([])
  })

  it('外部工具选择器在本地展开时不做任何事（由装配层从目录补）', () => {
    expect(expandToolSelectors([EXTERNAL_TOOLS], entries)).toEqual([])
    expect(expandToolSelectors(['bash', EXTERNAL_TOOLS], entries)).toEqual(['bash'])
  })

  it('混写去重且保持首次出现的顺序', () => {
    expect(
      expandToolSelectors(['bash', { category: 'core' }, 'plan-create', 'plan-create'], entries),
    ).toEqual(['bash', 'plan-create'])
  })

  it('写错的类别 / 空选择器当场报错', () => {
    expect(() => expandToolSelectors([''], entries)).toThrowError(/不能为空/)
    expect(() => expandToolSelectors(['plan create'], entries)).toThrowError(/不能包含空白/)
    expect(() => expandToolSelectors([{ category: 'nope' as never }], entries)).toThrowError(
      /未知的工具类别/,
    )
    expect(() => expandToolSelectors([{ foo: 'bar' } as never], entries)).toThrowError(
      /必须带 category/,
    )
    expect(() => expandToolSelectors([{ external: false } as never], entries)).toThrowError(
      /external 只能是 true/,
    )
  })
})

const buildRegistry = () => {
  const deps = buildToolStackDeps()
  const gateway = new ToolGateway(deps.config, silentLogger as never, deps.plugins, deps.clock)
  const registry = new ToolRegistry([new EventDeclTool()], gateway, deps.config)
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
    expect([...registry.childToolbox(['*']).keys()]).toEqual(['test-event-decl'])
    expect([...registry.childToolbox([]).keys()]).toEqual([])
  })
})
