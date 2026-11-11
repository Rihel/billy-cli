import { describe, expect, it } from 'vitest'
import type { AgentRunModel, AgentTimelineItemModel } from '@repo/shared'
import { toUIMessages } from '../src/app/(standalone)/main/ai/chat/history.ts'

/**
 * 时间线 → UIMessage 的映射（纯逻辑，node 环境）。
 *
 * 钉住三条会伤到用户的行为：
 * 1. 刷新后历史能重建（用户 + 助手两条消息）；
 * 2. 工具调用与结果**配对成一个 part**（否则工具卡片只有入参没有出参）；
 * 3. 子 agent 的明细**不进主对话**，但它的结论要合成成 `data-sub-agent` part
 *    （于是历史里的子助手面板与实时流看到的是同一种结构）。
 */

const CONVERSATION = 'conv_1'
const ROOT_RUN = 'run_1'
const CHILD_RUN = 'run_2'

const item = (
  partial: Partial<AgentTimelineItemModel> & { seq: number; kind: string },
): AgentTimelineItemModel =>
  ({
    id: `t${partial.seq}`,
    conversationId: CONVERSATION,
    runId: ROOT_RUN,
    messageId: '',
    attempt: 1,
    role: 'assistant',
    state: null,
    toolKey: null,
    toolCallId: null,
    startedAt: '2026-09-23T10:00:00.000Z',
    finishedAt: '2026-09-23T10:00:01.000Z',
    durationMs: 1000,
    usage: null,
    payload: null,
    ...partial,
  }) as AgentTimelineItemModel

const run = (id: string, parentRunId: string | null): AgentRunModel =>
  ({
    id,
    conversationId: CONVERSATION,
    parentRunId,
    depth: parentRunId ? 1 : 0,
    toolCallId: parentRunId ? 'call_1' : null,
    agentKey: parentRunId ? 'sub:待办统计' : 'assistant',
    triggeredBy: 'user_1',
    requestId: null,
    status: 'succeeded',
    recoveryCount: 0,
    errorCode: null,
    errorStage: null,
    errorMessage: null,
    durationMs: 1000,
    firstTokenMs: 100,
    stepCount: 1,
    toolCallCount: 1,
    usage: null,
  }) as AgentRunModel

describe('toUIMessages', () => {
  it('重建用户与助手两条消息，且保持 parts 顺序', () => {
    const messages = toUIMessages(
      [
        item({ seq: 1, kind: 'text', role: 'user', payload: { text: '帮我看看待办' } }),
        item({ seq: 2, kind: 'reasoning', payload: { text: '先列出来' } }),
        item({ seq: 3, kind: 'text', payload: { text: '共 2 条待办。' } }),
      ],
      [run(ROOT_RUN, null)],
    )

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(messages[0].parts[0]).toMatchObject({ type: 'text', text: '帮我看看待办' })

    const parts = messages[1].parts
    expect(parts.map((part) => part.type)).toEqual(['reasoning', 'text'])
    expect(parts[1]).toMatchObject({ type: 'text', text: '共 2 条待办。' })
  })

  it('工具调用与结果按 tool_call_id 配对成一个 part（含完整出参）', () => {
    const messages = toUIMessages(
      [
        item({
          seq: 1,
          kind: 'tool-call',
          toolKey: 'list-todos',
          toolCallId: 'call_a',
          payload: { toolCallId: 'call_a', toolName: 'list-todos', input: { limit: 3 } },
        }),
        item({
          seq: 2,
          kind: 'tool-result',
          toolKey: 'list-todos',
          toolCallId: 'call_a',
          payload: { toolCallId: 'call_a', toolName: 'list-todos', output: { total: 2 }, isError: false },
        }),
      ],
      [run(ROOT_RUN, null)],
    )

    expect(messages[0].parts).toHaveLength(1)
    expect(messages[0].parts[0]).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'list-todos',
      toolCallId: 'call_a',
      state: 'output-available',
      input: { limit: 3 },
      output: { total: 2 },
    })
  })

  it('消息 id 优先用时间线里的 messageId（与服务端流同源，重连才能"替换"而不是再 push 一条）', () => {
    const ASSISTANT_MESSAGE_ID = 'msg-assistant-uuid'
    const messages = toUIMessages(
      [
        item({ seq: 1, kind: 'text', role: 'user', payload: { text: '问一句' } }),
        item({
          seq: 2,
          kind: 'text',
          messageId: ASSISTANT_MESSAGE_ID,
          payload: { text: '回答' },
        }),
      ],
      [run(ROOT_RUN, null)],
    )

    // 助手消息的 id 就是流里的 messageId（`useChat({ resume: true })` 靠它对上号）
    expect(messages[1].id).toBe(ASSISTANT_MESSAGE_ID)
    // 用户消息在库里没有 messageId：退回稳定的 run 前缀 id（同 run 内唯一即可）
    expect(messages[0].id).toBe(`${ROOT_RUN}-user`)
  })

  it('工具卡按**调用发生的位置**就地铺开（踩过：攒到最后会让刷新后的历史与当时的界面不一样）', () => {
    // 复刻用户那条会话的形状：正文 → 两次工具调用 → 结果 → 正文 → 又一次工具调用 → 结果
    const messages = toUIMessages(
      [
        item({ seq: 1, kind: 'text', role: 'user', payload: { text: 'AI小说市场调研' } }),
        item({ seq: 2, kind: 'text', payload: { text: '先看看本机有没有素材。' } }),
        item({
          seq: 3,
          kind: 'tool-call',
          toolKey: 'bash',
          toolCallId: 'call_1',
          payload: { input: { command: 'pwd && ls -la' } },
        }),
        item({
          seq: 4,
          kind: 'tool-result',
          toolKey: 'bash',
          toolCallId: 'call_1',
          payload: { output: { ok: true, stdout: 'src' }, isError: false },
        }),
        item({
          seq: 5,
          kind: 'tool-call',
          toolKey: 'bash',
          toolCallId: 'call_2',
          payload: { input: { command: 'uname -a' } },
        }),
        item({
          seq: 6,
          kind: 'tool-result',
          toolKey: 'bash',
          toolCallId: 'call_2',
          payload: { output: { ok: true, stdout: 'Darwin' }, isError: false },
        }),
        item({ seq: 7, kind: 'text', payload: { text: '翻完了，交待一下结果。' } }),
        item({
          seq: 8,
          kind: 'tool-call',
          toolKey: 'bash',
          toolCallId: 'call_3',
          payload: { input: { command: 'ls ../' } },
        }),
        item({
          seq: 9,
          kind: 'tool-result',
          toolKey: 'bash',
          toolCallId: 'call_3',
          payload: { output: { ok: true, stdout: 'billy' }, isError: false },
        }),
      ],
      [run(ROOT_RUN, null)],
    )

    const kinds = messages[1].parts.map((part) =>
      part.type === 'text' ? 'text' : part.type === 'dynamic-tool' ? 'tool' : part.type,
    )
    expect(kinds).toEqual(['text', 'tool', 'tool', 'text', 'tool'])
    // 而且每个工具卡都配上了出参（就地补，不是另起一张）
    const tools = messages[1].parts.filter((part) => part.type === 'dynamic-tool')
    expect(tools).toHaveLength(3)
    for (const tool of tools) {
      expect(tool).toMatchObject({ state: 'output-available' })
      expect((tool as { output?: unknown }).output).toBeDefined()
    }
  })

  it('子 agent：明细不进主对话，但结论合成成 data-sub-agent part（与实时流同构）', () => {
    const messages = toUIMessages(
      [
        item({ seq: 1, kind: 'text', role: 'user', payload: { text: '统计一下' } }),
        item({
          seq: 2,
          kind: 'tool-call',
          toolKey: 'run-sub-agent',
          toolCallId: 'call_sub',
          payload: { toolCallId: 'call_sub', toolName: 'run-sub-agent', input: { name: '待办统计' } },
        }),
        item({
          seq: 3,
          kind: 'tool-result',
          toolKey: 'run-sub-agent',
          toolCallId: 'call_sub',
          payload: {
            toolCallId: 'call_sub',
            toolName: 'run-sub-agent',
            output: {
              subRunId: CHILD_RUN,
              name: '待办统计',
              status: 'succeeded',
              result: '共 2 条，1 条已完成',
              stepCount: 2,
              toolCallCount: 1,
              durationMs: 800,
              usage: { totalTokens: 152 },
            },
            isError: false,
          },
        }),
        // 子 run 自己的事件：属于审计资料，不该铺进主对话
        item({
          seq: 4,
          runId: CHILD_RUN,
          kind: 'text',
          payload: { text: '子助手结论：共 2 条待办' },
        }),
      ],
      [run(ROOT_RUN, null), run(CHILD_RUN, ROOT_RUN)],
    )

    const parts = messages[1].parts
    const subAgent = parts.find((part) => part.type === 'data-sub-agent')
    expect(subAgent).toBeDefined()
    expect(subAgent).toMatchObject({
      type: 'data-sub-agent',
      id: CHILD_RUN,
      data: { runId: CHILD_RUN, name: '待办统计', status: 'succeeded', result: '共 2 条，1 条已完成' },
    })
    // 子 run 的文本没有变成主对话里的 text part
    expect(parts.some((part) => part.type === 'text' && part.text.includes('子助手结论'))).toBe(false)
  })

  it('一轮的用量合成成 data-run-usage part（否则回看历史时统计全空）', () => {
    const messages = toUIMessages(
      [item({ seq: 1, kind: 'text', role: 'user', payload: { text: '跑一轮' } })],
      [
        {
          ...run(ROOT_RUN, null),
          usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cacheReadTokens: null },
          stepCount: 2,
          toolCallCount: 1,
          durationMs: 1234,
        } as AgentRunModel,
      ],
    )

    const usagePart = messages[1].parts.find((part) => part.type === 'data-run-usage')
    expect(usagePart).toBeDefined()
    expect((usagePart as { data: unknown }).data).toEqual({
      runId: ROOT_RUN,
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cacheReadTokens: null },
      stepCount: 2,
      toolCallCount: 1,
      durationMs: 1234,
    })
    // 附在 parts 末尾：与实时流（收尾下发）的位置一致
    expect(messages[1].parts.at(-1)?.type).toBe('data-run-usage')
  })

  it('没有用量记录时不合成该 part（不编造 0）', () => {
    const messages = toUIMessages(
      [
        item({ seq: 1, kind: 'text', role: 'user', payload: { text: '问一句' } }),
        item({ seq: 2, kind: 'text', payload: { text: '回答' } }),
      ],
      [run(ROOT_RUN, null)],
    )
    expect(messages[1].parts.some((part) => part.type === 'data-run-usage')).toBe(false)
  })

  it('计划事件合成成 data-plan part（payload 原样带上，供计划面板渲染）', () => {    // 新协议：plan 工具的出参 = { plan: Plan, change: { op, ... } }
    const planPayload = {
      plan: {
        goal: '整理待办周报',
        revision: 2,
        tasks: [
          { id: 't1', title: '取数', status: 'done' },
          { id: 't2', title: '写周报', status: 'in_progress', note: '等 t1' },
        ],
      },
      change: { op: 'update-task', taskId: 't2', status: 'in_progress' },
    }

    const messages = toUIMessages(
      [
        item({ seq: 1, kind: 'text', role: 'user', payload: { text: '整理一份待办周报' } }),
        item({
          seq: 2,
          kind: 'tool-call',
          toolKey: 'plan-update-task',
          toolCallId: 'call_plan',
          payload: { toolCallId: 'call_plan', toolName: 'plan-update-task', input: { taskId: 't2' } },
        }),
        item({
          seq: 3,
          kind: 'tool-result',
          toolKey: 'plan-update-task',
          toolCallId: 'call_plan',
          payload: {
            toolCallId: 'call_plan',
            toolName: 'plan-update-task',
            output: planPayload,
            isError: false,
          },
        }),
        // 计划事件（刷新后从库里重建的唯一来源）
        item({ seq: 4, kind: 'plan', payload: planPayload }),
      ],
      [run(ROOT_RUN, null)],
    )

    const planPart = messages[1].parts.find((part) => part.type === 'data-plan')
    expect(planPart).toBeDefined()
    expect(planPart).toMatchObject({ type: 'data-plan', id: 'plan-4' })
    // payload 原样带上（计划面板自己容错解析，history 不做二次加工）
    expect((planPart as { data: unknown }).data).toEqual(planPayload)
  })
})

describe('历史里的耗时（工具条与思考块要显示真实值）', () => {
  it('工具结果里的审计耗时（payload.outcome.durationMs）挂到工具卡 part 上', () => {
    const messages = toUIMessages(
      [
        item({ seq: 1, kind: 'tool-call', toolKey: 'bash', toolCallId: 'call_1' }),
        item({
          seq: 2,
          kind: 'tool-result',
          toolKey: 'bash',
          toolCallId: 'call_1',
          payload: { output: { ok: true }, isError: false, outcome: { durationMs: 2345 } },
        }),
      ],
      [run(ROOT_RUN, null)],
    )

    const toolPart = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'dynamic-tool') as { durationMs?: number } | undefined
    expect(toolPart?.durationMs).toBe(2345)
  })

  it('思考行自带 durationMs → 挂到 reasoning part 上（否则界面只能显示"思考完成"）', () => {
    const messages = toUIMessages(
      [item({ seq: 1, kind: 'reasoning', payload: { text: '想一下' }, durationMs: 3200 })],
      [run(ROOT_RUN, null)],
    )

    const reasoningPart = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'reasoning') as { durationMs?: number } | undefined
    expect(reasoningPart?.durationMs).toBe(3200)
  })
  it('带附件的用户消息：重建出 file part（含存储 key 与字节数，供回看展示）', () => {
    const messages = toUIMessages(
      [
        item({
          seq: 1,
          kind: 'text',
          role: 'user',
          payload: {
            text: '看看这张图',
            attachments: [
              { key: 'k1', filename: 'shot.png', mediaType: 'image/png', bytes: 2048 },
            ],
          },
        }),
        item({ seq: 2, kind: 'text', payload: { text: '这是一张截图。' } }),
      ],
      [run(ROOT_RUN, null)],
    )

    const userParts = messages[0].parts as unknown as Array<Record<string, unknown>>
    expect(userParts.map((part) => part.type)).toEqual(['text', 'file'])
    expect(userParts[1]).toMatchObject({
      type: 'file',
      filename: 'shot.png',
      mediaType: 'image/png',
      attachmentKey: 'k1',
      attachmentBytes: 2048,
    })
  })

  it('**只发附件、没打字**的用户消息也要重建（否则刷新后整条消失）', () => {
    const messages = toUIMessages(
      [
        item({
          seq: 1,
          kind: 'text',
          role: 'user',
          payload: {
            text: '',
            attachments: [
              { key: 'k2', filename: 'doc.pdf', mediaType: 'application/pdf', bytes: 1024 },
            ],
          },
        }),
        item({ seq: 2, kind: 'text', payload: { text: '这份文档讲的是……' } }),
      ],
      [run(ROOT_RUN, null)],
    )

    expect(messages).toHaveLength(2)
    const userParts = messages[0].parts as unknown as Array<Record<string, unknown>>
    expect(userParts).toHaveLength(1)
    expect(userParts[0]).toMatchObject({ type: 'file', filename: 'doc.pdf' })
  })

  it('附件形状不认识时当没有附件（老数据没有这个字段是正常的，不该把消息弄丢）', () => {
    // 两条用户消息要落在**不同 run** 上：同一个 run 里的用户事件会合并成一条消息
    const messages = toUIMessages(
      [
        item({ seq: 1, kind: 'text', role: 'user', payload: { text: '正常一问' } }),
        item({
          seq: 2,
          kind: 'text',
          role: 'user',
          runId: CHILD_RUN,
          payload: { text: '怪数据', attachments: 'oops' },
        }),
      ],
      [run(ROOT_RUN, null), run(CHILD_RUN, null)],
    )

    expect(messages).toHaveLength(2)
    expect(messages[1].parts).toHaveLength(1)
    expect(messages[1].parts[0]).toMatchObject({ type: 'text', text: '怪数据' })
  })
})
