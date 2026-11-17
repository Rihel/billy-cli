import { describe, expect, it, vi } from 'vitest'
import type { RuntimeModel } from '../src/modules/ai/core/envelope.js'
import { createPromptEngine } from '../src/modules/ai/core/prompts/index.js'
import { silentLogger } from './helpers/ai-tool-stack.js'

/**
 * 命名调用**用的是哪个模型对象**。
 *
 * 踩过的坑（2026-11-18，会话 `e7l7rsk8d35rwemgjgdh` 标题停在兜底名、`model_gateway_usage`
 * 里这个会话只有主回答那条记录）：命名原先拿 `decideModelForMastra(model).model` 当模型 ——
 * 那只是一段 `{ id, apiKey: '' }` 描述。生产环境的模型全走内部网关（真实 key 只在网关侧），
 * Mastra 拿空 key 去官方端点会在本地就失败，一次都没打到网关，于是所有标题都停在兜底名。
 *
 * 这里钉住：**必须走 `toMastraModelInstance`**（与主回答同一个入口，网关模式下带内部令牌 + 归因头）。
 */
const { toMastraModelInstance } = vi.hoisted(() => ({
  toMastraModelInstance: vi.fn(async () => ({ instance: {}, config: {} })),
}))

vi.mock('../src/modules/ai/mastra/agent.adapter.js', () => ({ toMastraModelInstance }))

const { AgentTitleService } = await import('../src/modules/ai/runtime/title.service.js')

/** 生产形态的模型：网关模式（apiKey 为空串，真实 key 只在网关） */
const gatewayModel: RuntimeModel = {
  id: 'm1',
  modelRef: 'deepseek/deepseek-chat',
  modelKey: 'deepseek-chat',
  displayName: 'DeepSeek Chat',
  providerKind: 'deepseek',
  apiKey: '',
  contextWindow: 64_000,
  inputModalities: ['text'],
  gateway: { url: 'http://127.0.0.1:9992', token: 'dev-model-token', modelId: 'm1' },
}

describe('首轮命名：模型实例的取法', () => {
  it('走 `toMastraModelInstance`（网关模式才打得到网关），不拿 apiKey 为空的描述去调模型', async () => {
    const service = new AgentTitleService(createPromptEngine(), silentLogger as never)

    await service.generateFirstTurnTitle({
      conversationId: 'conv_1',
      runId: 'run_1',
      message: '帮我看看最近有哪些待办',
      model: gatewayModel,
    })

    expect(toMastraModelInstance).toHaveBeenCalledTimes(1)
    expect(toMastraModelInstance).toHaveBeenCalledWith(gatewayModel)
  })
})
