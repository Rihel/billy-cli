import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { toAISdkStream } from '@mastra/ai-sdk'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createMastraAgent, toMastraModelInstance } from '../src/modules/ai/mastra/agent.adapter.js'
import { ToolOutcomeError } from '../src/modules/ai/mastra/tool.adapter.js'
import { toUiStream } from '../src/modules/ai/mastra/stream.adapter.js'
import { createDeepSeek } from '@ai-sdk/deepseek'
import type { RuntimeModel } from '../src/modules/ai/core/envelope.js'
import { startMockModelServer, type MockModelServer } from './helpers/mock-model-server.js'

/**
 * 适配器一致性测试（设计 §5.8）：**我们押在 Mastra 上的行为**，升级 `@mastra/core` 时先跑它。
 *
 * 挂了说明 `ai/mastra/**` 的适配器要改，主体（`ai/tools/**`）不受影响。
 * 三条结论都是在本机实测出来的（2026-10-01，`@mastra/core@1.69.0`）：
 *
 * 1. **durable（线上默认）下 `toModelOutput` 生效**：流里的 `tool-output-available` 仍是**全量**
 *    （→ 时间线 → 前端），而模型侧收到的是映射后的那一份 ⇒ 分页可以只改"给模型那一份"，
 *    不破坏"入参出参全量入库"这条硬规则（设计 §5.6）；
 * 2. **agent 级 `beforeToolCall` 在 durable 下同样生效，且能短路**（返回 `{proceed:false, output}`）。
 *    我们仍然选择包 `execute`：那样网关与插件不必认识 Mastra 的钩子 API，主体保持框架无关
 *    （适配器只做一次映射）。这条行为约定固定"钩子是可用选项"这个事实，避免以后误判；
 * 3. **未知工具落成 `tool-output-error`，整轮继续**（错误文本里是 `ToolNotFoundError`）⇒
 *    "拦截不存在的工具"是补强与审计，不是从零实现。
 */

/** 全量出参里的标记（必须留在流里） */
const FULL_MARKER = 'FULL-OUTPUT-MARKER'
/** 映射后给模型的那一份里的标记（必须出现在模型请求里） */
const PAGED_MARKER = 'PAGED-VIEW-MARKER'
/** 让出参足够大的填充（断言"流里是全量"用） */
const FILL = 'x'.repeat(4000)

interface ChunkLike {
  type?: string
  toolName?: string
  toolCallId?: string
  output?: unknown
  input?: unknown
  errorText?: string
}

/**
 * 造一个 mock 会调用的工具（它认得的名字是 `plan-create`）。
 *
 * 注意 Mastra 解析工具时会**按 `id` 兜底匹配**（实测）：记录里的 key 与工具 `id` 不一致时，
 * 只要 `id` 命中就仍然会执行 —— 所以造"未知工具"的用例必须让两边都不同名。
 */
const buildTool = (options: { toModelOutput?: boolean; id?: string } = {}) =>
  createTool({
    id: options.id ?? 'plan-create',
    description: '一致性测试用工具：返回一份大出参',
    inputSchema: z.object({ goal: z.string().optional(), tasks: z.array(z.unknown()).optional() }),
    ...(options.toModelOutput
      ? {
          toModelOutput: (output: unknown) => ({
            type: 'text',
            value: `${PAGED_MARKER}:${JSON.stringify(output).length}`,
          }),
        }
      : {}),
    execute: async () => ({ marker: FULL_MARKER, fill: FILL }),
  }) as never

/** 跑一轮并收集 UI 流片段（mock：带工具且本轮没有工具结果 → 先调一次 `plan-create`，再回文本） */
const runOnce = async (
  agent: Agent,
  marker: string,
  chunkSink: ChunkLike[] = [],
): Promise<ChunkLike[]> => {
  const output = await agent.stream([{ role: 'user', content: `跑一次 ${marker}` }] as never, {
    maxSteps: 4,
  })
  const uiStream = toAISdkStream(output as never, {
    from: 'agent',
    version: 'v6',
    sendReasoning: true,
    sendSources: true,
  })
  const reader = (uiStream as unknown as ReadableStream<ChunkLike>).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunkSink.push(value)
  }
  return chunkSink
}

/** 收集一条 UI 流的全部片段（`toUiStream` 出口，与线上同一条转换） */
const collectUi = async (stream: ReadableStream<unknown>): Promise<ChunkLike[]> => {
  const reader = (stream as unknown as ReadableStream<ChunkLike>).getReader()
  const chunks: ChunkLike[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

/** 模型最近一次请求里带工具结果的那条消息（`role: 'tool'`）的全文 */
const lastToolMessage = (mock: MockModelServer): string => {
  const withToolResult = mock.requests.filter((body) =>
    JSON.stringify(body.messages ?? []).includes('"role":"tool"'),
  )
  return JSON.stringify(withToolResult[withToolResult.length - 1]?.messages ?? [])
}

const buildAgent = (
  mock: MockModelServer,
  options: { tools: Record<string, unknown>; id: string; hooks?: unknown; durable?: boolean },
) =>
  new Agent({
    id: options.id,
    name: options.id,
    instructions: '按工具结果回答',
    model: { id: 'openai/mock-model', url: mock.baseURL, apiKey: 'test' },
    tools: options.tools as never,
    durable: options.durable ?? true,
    ...(options.hooks ? { hooks: options.hooks as never } : {}),
  })

describe('适配器行为约定：Mastra 行为（升级前先跑这份）', () => {
  let mock: MockModelServer

  beforeAll(async () => {
    mock = await startMockModelServer()
  })

  afterAll(async () => {
    await mock.close()
  })

  it('用例 ①：durable 下 toModelOutput 生效 —— 流里是全量，模型收到映射结果', async () => {
    const chunks: ChunkLike[] = []
    const agent = buildAgent(mock, {
      id: 'contract-durable',
      tools: { 'plan-create': buildTool({ toModelOutput: true }) },
    })

    await runOnce(agent, '[用例-durable]', chunks)

    // 流里（→ 时间线 → 前端）必须是全量
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-output-available')
    expect(resultChunk, '流里应该有工具结果片段').toBeDefined()
    const streamed = JSON.stringify(resultChunk?.output)
    expect(streamed).toContain(FULL_MARKER)
    expect(streamed).toContain(FILL.slice(0, 200))

    // 模型侧收到的是映射后的那一份
    const modelSaw = lastToolMessage(mock)
    expect(modelSaw).toContain(PAGED_MARKER)
    expect(modelSaw).not.toContain(FULL_MARKER)
  })

  it('用例 ①-b（对照）：不配 toModelOutput 时，模型收到的是全量', async () => {
    const agent = buildAgent(mock, {
      id: 'contract-plain',
      tools: { 'plan-create': buildTool() },
    })

    await runOnce(agent, '[用例-对照]')
    expect(lastToolMessage(mock)).toContain(FULL_MARKER)
  })

  it('用例 ②：agent 级 beforeToolCall 在 durable 下生效，且能短路（proceed:false 返回结论）', async () => {
    const hookCalls: string[] = []
    let executed = 0
    const tool = createTool({
      id: 'plan-create',
      description: '一致性测试：短路用',
      inputSchema: z.object({ goal: z.string().optional(), tasks: z.array(z.unknown()).optional() }),
      execute: async () => {
        executed += 1
        return { marker: FULL_MARKER }
      },
    }) as never

    const agent = buildAgent(mock, {
      id: 'contract-hooks',
      tools: { 'plan-create': tool },
      hooks: {
        beforeToolCall: (context: { toolName: string }) => {
          hookCalls.push(context.toolName)
          return { proceed: false as const, output: { denied: 'HOOK-SHORT-CIRCUIT' } }
        },
      },
    })

    await runOnce(agent, '[用例-hooks]')

    // 钩子被调用（所以 durable 下这条路是通的），工具被短路（没执行）
    expect(hookCalls).toEqual(['plan-create'])
    expect(executed, 'beforeToolCall 返回 proceed:false 时工具不应执行').toBe(0)
    // 短路结论确实交给了模型
    expect(lastToolMessage(mock)).toContain('HOOK-SHORT-CIRCUIT')
  })

  it('用例 ③：未知工具落成 tool-output-error，整轮继续跑完', async () => {
    const chunks: ChunkLike[] = []
    const agent = buildAgent(mock, {
      id: 'contract-unknown',
      tools: { 'some-other-tool': buildTool({ id: 'some-other-tool' }) },
    })

    await runOnce(agent, '[用例-未知工具]', chunks)

    const errorChunk = chunks.find((chunk) => chunk.type === 'tool-output-error')
    expect(errorChunk, '未知工具应该有 tool-output-error 片段').toBeDefined()
    expect(String(errorChunk?.errorText)).toContain('ToolNotFoundError')
    // 整轮不失败：继续产出文本
    expect(
      chunks.filter((chunk) => chunk.type === 'text-delta').length,
      '整轮应继续跑完并产出文本',
    ).toBeGreaterThan(0)
  })

  /**
   * 用例 ④：**工具失败的错误文本只有结论**（2026-10 用户反馈"为啥错误直接把 json 和堆栈都弄出来了"）。
   *
   * 上游 `@mastra/ai-sdk` 默认把错误对象 `JSON.stringify` 成 `errorText`：
   * - durable 开：错误序列化成 `{ name, message, stack }` 普通对象 → JSON 里带整段 `@mastra/core` 堆栈；
   * - durable 关：`MastraError` 实例 → 名字 / cause / details 一起进 JSON。
   * 我们在 `toUiStream` 里给了 `onError = toErrorText`，两条路都必须只剩一句结论。
   */
  it('用例 ④：工具失败的错误文本只有结论 —— 无堆栈、无 JSON（durable 开 / 关都验）', async () => {
    const message = '请求失败：https://example.com（Connect Timeout Error）'
    const hint = '站点可能不可达或被墙；换一个来源'
    const failingTool = createTool({
      id: 'plan-create',
      description: '一致性测试：每次都失败',
      inputSchema: z.object({ goal: z.string().optional(), tasks: z.array(z.unknown()).optional() }),
      execute: async () => {
        throw new ToolOutcomeError('invalid-input', message, hint)
      },
    }) as never

    for (const durable of [false, true]) {
      const agent = buildAgent(mock, {
        id: `contract-error-${durable}`,
        tools: { 'plan-create': failingTool },
        durable,
      })
      const output = await agent.stream([{ role: 'user', content: '跑一次 [用例-失败]' }] as never, {
        maxSteps: 4,
      })
      const chunks = await collectUi(toUiStream(output))
      const errorChunk = chunks.find((chunk) => chunk.type === 'tool-output-error')
      expect(errorChunk, `durable=${durable} 应该有工具错误片段`).toBeDefined()
      expect(errorChunk?.errorText, `durable=${durable} 的错误文本应只有结论`).toBe(
        `${message}（${hint}）`,
      )
    }
  })
})

describe('toMastraModelInstance（多模态回归防线）', () => {
  /**
   * 为什么单独立一组：这个函数必须返回**可直接调用的模型实例**，而不是 `{ id, apiKey }`
   * 这类配置对象 —— 配置对象要 Mastra 自己去解析，中间多一层，而多模态内容曾在那一层被丢掉
   * （2026-10-07 的事故，见下面"durable 下的多模态"那一组；根因是 Mastra 在 durable 下压平，
   * 不在本函数）。
   *
   * 所以这里的断言不是"函数能跑"，而是"返回的东西**自带 `doStream` / `doGenerate`**"。
   */
  const deepseekModel: RuntimeModel = {
    id: 'model_1',
    modelRef: 'deepseek/deepseek-flash',
    modelKey: 'deepseek-flash',
    displayName: 'DeepSeek Flash',
    providerKind: 'deepseek',
    apiKey: 'sk-test',
    contextWindow: 64_000,
    inputModalities: ['text', 'image'],
  }

  it('DeepSeek 官方适配 → 返回**真正可调用的模型实例**（带 doStream/doGenerate）', async () => {
    const { instance, config } = await toMastraModelInstance(deepseekModel)

    expect(typeof (instance as { doStream?: unknown })?.doStream).toBe('function')
    expect(typeof (instance as { doGenerate?: unknown })?.doGenerate).toBe('function')
    // 描述仍按"官方适配不传 url"的口径（传了会丢掉思考字段）
    expect(config.id).toBe('deepseek/deepseek-flash')
    expect(config.url).toBeUndefined()
  })

  it('配了自定义地址但不走官方适配 → 也返回实例（凭据不回显进描述里）', async () => {
    const { instance } = await toMastraModelInstance({
      ...deepseekModel,
      providerKind: 'openai-compatible',
      modelRef: 'my-gw/qwen-max',
      modelKey: 'qwen-max',
      baseURL: 'http://127.0.0.1:1/v1',
    })

    expect(instance).toBeTruthy()
    expect(typeof instance).toBe('object')
  })

describe('durable 下的多模态（图片必须真的发到供应商）', () => {
  /**
   * ## 为什么单独立这一条（2026-10-07 的真实事故）
   *
   * 症状：发图后模型回答"我没收到图片"，看着像"模型不支持读图"。
   * 实测根因**不在我们的适配代码**：`@mastra/core@1.69.0` 在 **`durable: true`**
   * （崩溃恢复，线上默认开启）时会把多模态消息的 `content` 数组**压平成纯字符串** ——
   * 出站请求 156 字节、`content: "看图"`，图片被静默丢掉。
   * 升级到 `1.78.0` 后同样输入变成含 `image_url` 的 1.7KB+ 请求。
   *
   * 这条测试挡的是**回归**：一旦退化，它立刻红，而不是等用户发现"模型读不到图"。
   * 注意它必须走 `durable: true` 这条路 —— 不传 durable 时这个 bug 根本不出现
   * （早先的 e2e 用 mock 且走非 durable，所以完全看不见它）。
   */
  it('durable agent：出站请求里带 image_url（图片没被压平）', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`

    const bodies: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      const url = String(
        typeof input === 'string' ? input : ((input as { url?: string })?.url ?? input),
      )
      if (url.includes('deepseek.com')) {
        bodies.push(typeof init?.body === 'string' ? init.body : '')
        return new Response(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 1,
            model: 'deepseek-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return originalFetch(input as never, init as never)
    }) as typeof fetch

    try {
      const agent = createMastraAgent({
        id: 'contract-durable-multimodal',
        name: '契约',
        instructions: 'x',
        // 与生产一致：Agent 上挂动态 model（函数），调用时再显式传实例
        model: (() => ({ id: 'deepseek/deepseek-flash' as never, apiKey: 'sk-test' })) as never,
        tools: {} as never,
        skills: [] as never,
        durable: true,
      })
      const deepseek = createDeepSeek({ apiKey: 'sk-test', baseURL: 'https://api.deepseek.com' })
      const stream = await agent.stream(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: '看图' },
              { type: 'image', image: dataUrl, mediaType: 'image/png' },
            ],
          },
        ] as never,
        { model: deepseek('deepseek-flash') as never } as never,
      )
      for await (const _chunk of ((stream as { fullStream?: AsyncIterable<unknown> }).fullStream ?? [])) {
        void _chunk
      }
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(bodies.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(bodies[0] ?? '{}') as {
      messages?: Array<{ role: string; content: unknown }>
    }
    /**
     * 断言**结构**而不是字节数：压平时 user 的 `content` 会变成纯字符串
     * （`"看图"` 三个字，请求体 100~200 字节），带图时必须是 part 数组。
     * 用结构判据即便换成很小的测试图也分得清。
     */
    const userMessage = body.messages?.find((message) => message.role === 'user')
    expect(Array.isArray(userMessage?.content)).toBe(true)
    expect(JSON.stringify(userMessage?.content)).toContain('image_url')
    expect(bodies[0]).toContain(dataUrl)
  })
})
})
