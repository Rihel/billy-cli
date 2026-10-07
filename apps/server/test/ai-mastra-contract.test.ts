import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { toAISdkStream } from '@mastra/ai-sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
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

/** 模型最近一次请求里带工具结果的那条消息（`role: 'tool'`）的全文 */
const lastToolMessage = (mock: MockModelServer): string => {
  const withToolResult = mock.requests.filter((body) =>
    JSON.stringify(body.messages ?? []).includes('"role":"tool"'),
  )
  return JSON.stringify(withToolResult[withToolResult.length - 1]?.messages ?? [])
}

const buildAgent = (
  mock: MockModelServer,
  options: { tools: Record<string, unknown>; id: string; hooks?: unknown },
) =>
  new Agent({
    id: options.id,
    name: options.id,
    instructions: '按工具结果回答',
    model: { id: 'openai/mock-model', url: mock.baseURL, apiKey: 'test' },
    tools: options.tools as never,
    durable: true,
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
})
