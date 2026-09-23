import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 离线 mock 模型服务（OpenAI 兼容）：**端到端测试用的假模型**，不依赖任何外部密钥。
 *
 * 行为刻意做得确定，便于断言：
 * 1. 请求里带了工具、且还没有任何 tool 结果 → 先发一次工具调用（`list-todos`）；
 * 2. 否则 → 回固定文本（代表"拿到工具结果后的最终回答"）。
 *
 * 同时支持非流式（`stream: false`）与流式（`stream: true`，SSE）两种响应，
 * 因为运行时的两条链路都要用它验证。
 */

export interface MockModelServer {
  /** 形如 `http://127.0.0.1:PORT/v1`，直接填进 MASTRA_BASE_URL */
  baseURL: string
  /** 收到的请求体（便于断言"模型到底收到了什么"） */
  requests: Array<Record<string, unknown>>
  close: () => Promise<void>
}

/** 固定回复文本（断言用） */
export const MOCK_FINAL_TEXT = '已为你查到最近的待办，共 2 条。'
/** 固定工具入参（断言"入参完整落库"用） */
export const MOCK_TOOL_INPUT = { limit: 3, keyword: '演示' }
/** 固定工具出参（断言"出参完整落库、不裁剪"用） */
export const MOCK_TOOL_OUTPUT = { total: 2, items: [{ id: 't1', title: '写设计文档' }] }

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** 判断这一轮该不该发工具调用 */
const shouldCallTool = (body: Record<string, unknown>): boolean => {
  const tools = body.tools
  if (!Array.isArray(tools) || tools.length === 0) return false
  const messages = Array.isArray(body.messages) ? body.messages : []
  return !messages.some((message) => (message as { role?: string }).role === 'tool')
}

const usage = () => ({ prompt_tokens: 128, completion_tokens: 24, total_tokens: 152 })

/** 用户消息里带这个标记时，模型改为调用「规划」工具（验证规划能力） */
export const MOCK_PLAN_MARKER = '[plan]'
/** 固定计划（断言"计划完整落库"用） */
export const MOCK_PLAN = {
  goal: '把待办整理成周报',
  steps: [
    { id: 's1', title: '取最近的待办', status: 'in_progress' },
    { id: 's2', title: '按主题分组', status: 'pending' },
  ],
}

const wantsPlan = (body: Record<string, unknown>): boolean =>
  JSON.stringify(body.messages ?? []).includes(MOCK_PLAN_MARKER)

/** 子 agent 那一轮的标记（只出现在**主 agent 现场写的 system_prompt** 里） */
export const MOCK_CHILD_MARKER = '[child]'

/** 用户消息里带这个标记时，模型改为调用「子 agent 工具」（验证动态子 agent 能力） */
export const MOCK_DELEGATE_MARKER = '[delegate]'
/** 子 agent 工具 key（主 agent 用它创建一个临时子助手） */
export const MOCK_DELEGATE_TOOL = 'run-sub-agent'
/** 子助手短标识（断言 `runs.agent_key = sub:<name>` 用） */
export const MOCK_SUBAGENT_NAME = '待办统计'
/** 主 agent **现场撰写**的子助手提示词（含 `[child]` 标记，让 mock 认出"这是子 agent 那一轮"） */
export const MOCK_SUBAGENT_PROMPT = `你是待办统计子助手 ${MOCK_CHILD_MARKER}：只做统计，输出结论与口径。`
/** 交给子助手的任务（断言全量落库用） */
export const MOCK_SUBAGENT_TASK = '统计当前待办的完成情况，给出总数与已完成数'
/** 子 agent 那一轮的固定结论文本（父拿到的工具出参里应含它） */
export const MOCK_CHILD_TEXT = '子助手结论：共 2 条待办，其中 1 条已完成。'

const wantsDelegate = (body: Record<string, unknown>): boolean =>
  JSON.stringify(body.messages ?? []).includes(MOCK_DELEGATE_MARKER)

const toolCallPayload = (body?: Record<string, unknown>) => {
  if (body && wantsDelegate(body)) {
    return [
      {
        index: 0,
        id: 'call_mock_delegate',
        type: 'function',
        function: {
          name: MOCK_DELEGATE_TOOL,
          // 动态子 agent 的协议：提示词由主 agent 现写、任务自包含
          arguments: JSON.stringify({
            name: MOCK_SUBAGENT_NAME,
            system_prompt: MOCK_SUBAGENT_PROMPT,
            task: MOCK_SUBAGENT_TASK,
          }),
        },
      },
    ]
  }
  const plan = body && wantsPlan(body)
  return [
    {
      index: 0,
      id: plan ? 'call_mock_plan' : 'call_mock_1',
      type: 'function',
      function: {
        name: plan ? 'write-plan' : 'list-todos',
        arguments: JSON.stringify(plan ? MOCK_PLAN : MOCK_TOOL_INPUT),
      },
    },
  ]
}

const respondJson = (res: ServerResponse, body: Record<string, unknown>): void => {
  const useTool = shouldCallTool(body)
  const message = useTool
    ? { role: 'assistant', content: null, tool_calls: toolCallPayload(body) }
    : { role: 'assistant', content: finalText(body) }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
      choices: [
        {
          index: 0,
          message,
          finish_reason: useTool ? 'tool_calls' : 'stop',
        },
      ],
      usage: usage(),
    }),
  )
}

const sse = (res: ServerResponse, payload: unknown): void => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** 用户消息里带这个标记时，逐字慢速输出（用于验证"停止"与"断线补发"） */
export const MOCK_SLOW_MARKER = '[slow]'

/** 这一轮请求是不是"子 agent 那一轮"（看系统提示词里有没有标记） */
const isChildTurn = (body: Record<string, unknown>): boolean =>
  JSON.stringify(body.messages ?? []).includes(MOCK_CHILD_MARKER)

/** 这一轮的最终文本（子 agent 与主 agent 用不同文本，便于断言"结论确实来自子助手"） */
const finalText = (body: Record<string, unknown>): string =>
  isChildTurn(body) ? MOCK_CHILD_TEXT : MOCK_FINAL_TEXT

const isSlow = (body: Record<string, unknown>): boolean => {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return JSON.stringify(messages).includes(MOCK_SLOW_MARKER)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const respondStream = (res: ServerResponse, body: Record<string, unknown>): void => {
  const useTool = shouldCallTool(body)
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  const base = {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
  }

  if (useTool) {
    sse(res, {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', tool_calls: toolCallPayload(body) },
          finish_reason: null,
        },
      ],
    })
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  } else {
    sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
    const slow = isSlow(body)
    const text = finalText(body)
    const deltas = slow
      ? sseSlow(res, base, text)
      : (() => {
          for (const char of [...text]) {
            sse(res, { ...base, choices: [{ index: 0, delta: { content: char }, finish_reason: null }] })
          }
          return Promise.resolve()
        })()
    void deltas.then(() => {
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      sse(res, { ...base, choices: [], usage: usage() })
      res.write('data: [DONE]\n\n')
      res.end()
    })
    return
  }
  // 最后一帧带 usage（OpenAI 在 stream_options.include_usage 时的约定）
  sse(res, { ...base, choices: [], usage: usage() })
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 慢速逐字输出（每次 40ms），给"停止"测试留出可打断的窗口 */
const sseSlow = async (
  res: ServerResponse,
  base: Record<string, unknown>,
  text: string,
): Promise<void> => {
  for (const char of [...text]) {
    if (res.writableEnded) return
    sse(res, { ...base, choices: [{ index: 0, delta: { content: char }, finish_reason: null }] })
    await sleep(40)
  }
}

/** 启动 mock 服务（端口随机，避免与本机其它服务冲突） */
export const startMockModelServer = async (): Promise<MockModelServer> => {
  const requests: Array<Record<string, unknown>> = []
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
        res.writeHead(404).end()
        return
      }
      const body = await readBody(req)
      requests.push(body)
      if (body.stream === true) respondStream(res, body)
      else respondJson(res, body)
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}
