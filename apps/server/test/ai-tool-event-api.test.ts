import { AiToolUpdateSchema } from '@repo/shared'
import { describe, expect, it } from 'vitest'
import { AiToolService } from '../src/modules/ai/api/ai-tool.service.js'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { ToolRegistry } from '../src/modules/ai/core/tools/tool.registry.js'
import { buildToolStackDeps, silentLogger } from './helpers/ai-tool-stack.js'
import { EventDeclTool, NoEventTool } from '../src/modules/ai/tools/tool-event-testkit.js'

/**
 * 管理台接口返回的 events（设计 §5.17）：**必须与代码声明一致**。
 *
 * 这条接口是前端渲染器注册表的对账依据（"这个工具会吐哪些事件、payload 长什么样"），
 * 所以它取的是库里那份**启动期镜像**，老行 / 没同步过就现算一次兜底 —— 两条路径的结果相同。
 */
const serviceOf = () => {
  const deps = buildToolStackDeps()
  const gateway = new ToolGateway(deps.config, silentLogger as never, [], deps.clock)
  const registry = new ToolRegistry(
    [new EventDeclTool(), new NoEventTool()],
    gateway,
    deps.config,
  )
  // agent 授权清单只用于 `agents` 字段，这两条断言用不到 → 给空注册表
  const agents = { all: () => [] } as never
  return new AiToolService(registry, {} as never, agents, silentLogger as never)
}

describe('管理台接口：events 与代码声明一致', () => {
  it('detail 返回归一化后的声明（mode 默认值 + payloadSchema）', async () => {
    const detail = await serviceOf().detail('test-event-decl')
    expect(detail.events.map((event) => [event.name, event.mode])).toEqual([
      ['progress', 'state'],
      ['log-line', 'stream'],
      ['stage', 'state'],
    ])
    expect(detail.events[0].payloadSchema).toMatchObject({ type: 'object' })
    expect(detail.events[0]).toMatchObject({ title: '进度', description: '阶段性进度快照' })
  })

  it('list 里每一条都带上自己的 events（不是只在详情里有）', async () => {
    const page = await serviceOf().list({ page: 1, size: 20 })
    const withEvents = page.items.find((tool) => tool.toolKey === 'test-event-decl')
    const withoutEvents = page.items.find((tool) => tool.toolKey === 'test-no-event')
    expect(withEvents?.events).toHaveLength(3)
    expect(withoutEvents?.events).toEqual([])
  })

  it('events 不可编辑：更新入参契约里根本没有这个字段（前端也传不进来）', () => {
    const parsed = AiToolUpdateSchema.safeParse({ toolKey: 'test-event-decl', events: [{ name: '偷偷加的' }] })
    expect(parsed.success).toBe(true)
    // 未知字段被剥掉，写库那条路上永远拿不到 events
    expect(parsed.success && 'events' in parsed.data).toBe(false)
  })
})
