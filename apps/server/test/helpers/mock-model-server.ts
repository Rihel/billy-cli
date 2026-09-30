import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 离线 mock 模型服务（OpenAI 兼容）：**端到端测试用的假模型**，不依赖任何外部密钥。
 *
 * 行为刻意做得确定，便于断言：
 * 1. 请求里带了工具、且本轮还没有任何工具结果 → 先发一次工具调用（默认 `todo-write`）；
 * 2. 否则 → 回固定文本（代表"拿到工具结果后的最终回答"）。
 *
 * 三个标记载荷把"多步行为"确定下来（都写在**用户消息**里）：
 * - `[delegate]`：改调 `run-sub-agent`；
 * - `[command]`：改调 `run-command`（真跑一条 `echo`，验证跨平台命令执行链路）；
 * - `[todo-overwrite]`：第二轮提交一份**改动过的完整清单**（加任务 / 改状态 / 隐式删任务）；
 * - `[todo-react]`：**同一轮内连提交两次**（第二次的入参里带上第一次新增的任务）。
 *
 * 同时支持非流式（`stream: false`）与流式（`stream: true`，SSE）两种响应，
 * 因为运行时的两条链路都要用它验证。
 */

export interface MockModelServer {
  /** 形如 `http://127.0.0.1:PORT/v1`，直接填进 MASTRA_BASE_URL */
  baseURL: string
  /** 收到的请求体（便于断言"模型到底收到了什么"） */
  requests: Array<Record<string, unknown>>
  /** 收到的 `GET /models` 请求（url + Authorization 头；供 AI 模型模块的同步测试断言） */
  listRequests: Array<{ url: string; authorization: string | undefined }>
  close: () => Promise<void>
}

/**
 * `GET {base}/models` 返回的 OpenAI 形态假模型列表。
 *
 * 刻意覆盖两种情形，供"同步落模型明细"的测试断言：
 * - 字段齐全（`id` / `created` / `owned_by` 都有，全量进 `raw`）；
 * - 窗口类字段本来就没有（OpenAI 的 `/models` 不返回窗口）—— 同步后必须是 `null`，**不许编造**。
 */
export const MOCK_MODEL_LIST = [
  { id: 'mock-chat', object: 'model', created: 1700000000, owned_by: 'mock-vendor' },
  { id: 'mock-reasoner', object: 'model', created: 1700000001, owned_by: 'mock-vendor' },
]

/** 固定回复文本（断言用） */
export const MOCK_FINAL_TEXT = '好，清单已经记下，我按步骤继续推进。'

// ── 任务清单（`todo-write`）─────────────────────────────────────────────────
/** 唯一的通用工具 key：提交**完整任务清单**（全量覆盖） */
export const MOCK_TODO_TOOL = 'todo-write'

/** 默认的首次提交：一份完整清单（全量提交，不是增量） */
export const MOCK_TODO_INITIAL = {
  goal: '把待办整理成周报',
  tasks: [
    { id: 't1', title: '取最近的待办', status: 'in_progress' },
    { id: 't2', title: '按主题分组', status: 'pending' },
  ],
}

/** 用户消息里带这个标记时，第二轮提交一份改动过的完整清单（验证全量覆盖） */
export const MOCK_TODO_OVERWRITE_MARKER = '[todo-overwrite]'
/** 覆盖版清单里新增任务的标题标记（用来判断"这一版已经提交过了"） */
export const MOCK_OVERWRITE_TOKEN = '[覆盖]'
/**
 * 覆盖版：t1 完成、t3 新增、**t2 不再出现（= 删除）**，目标也改了一版。
 *
 * 一份提交同时表达"加 / 改 / 删 / 换目标"四件事 —— 这正是全量清单语义要证明的能力。
 */
export const MOCK_TODO_OVERWRITE = {
  goal: '把待办整理成周报（已收敛）',
  tasks: [
    { id: 't1', title: '取最近的待办', status: 'completed' },
    { id: 't3', title: `补充核对口径 ${MOCK_OVERWRITE_TOKEN}`, status: 'in_progress' },
  ],
}

/** 用户消息里带这个标记时：同一轮内连提交两次清单（验证同轮内能读到彼此的结果） */
export const MOCK_TODO_REACT_MARKER = '[todo-react]'
/** 第一次提交新增的任务标题标记 */
export const MOCK_REACT_FIRST_TOKEN = '[react-1]'
/** 第二次提交新增的任务标题标记 */
export const MOCK_REACT_SECOND_TOKEN = '[react-2]'
/** 同一轮内的第一次提交：替换掉上一版，新增 r2 */
export const MOCK_TODO_REACT_FIRST = {
  goal: '整理评审材料',
  tasks: [
    { id: 'r1', title: '起草初稿', status: 'completed' },
    { id: 'r2', title: `补充数据 ${MOCK_REACT_FIRST_TOKEN}`, status: 'in_progress' },
  ],
}
/**
 * 同一轮内的第二次提交：**入参里带着第一次新增的 r2**，并把它标成完成、再加一项 r3。
 *
 * 运行时在整轮结束后才落 `plan` 事件，所以第二次能算出"比第一次更大的 revision"，
 * 只可能是因为它读到了第一次在本轮内存里留下的结果 —— 这就是"react 循环里能调整清单"的硬证明。
 */
export const MOCK_TODO_REACT_SECOND = {
  goal: '整理评审材料',
  tasks: [
    { id: 'r1', title: '起草初稿', status: 'completed' },
    { id: 'r2', title: `补充数据 ${MOCK_REACT_FIRST_TOKEN}`, status: 'completed' },
    { id: 'r3', title: `交叉校验 ${MOCK_REACT_SECOND_TOKEN}`, status: 'in_progress' },
  ],
}

// ── 子 agent ──────────────────────────────────────────────────────────────
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

// ── 命令执行 ───────────────────────────────────────────────────────────────
/** 用户消息里带这个标记时，模型改为调用「命令执行工具」（验证跨平台跑命令这条链路） */
export const MOCK_COMMAND_MARKER = '[command]'
/** 命令执行工具 key（agent 用它在本机跑一条命令） */
export const MOCK_COMMAND_TOOL = 'run-command'
/** 命令输出的标记串（断言 stdout 里真的有它） */
export const MOCK_COMMAND_OUTPUT = 'billy-command-ok'
/**
 * 要执行的命令：`echo` 在 `cmd.exe` 与 `/bin/sh` 下都存在，
 * 所以同一条命令在三端都能跑通 —— 测的正是"跨平台"这件事。
 */
export const MOCK_COMMAND = `echo ${MOCK_COMMAND_OUTPUT}`

// ── 会话命名（首轮结束后那次隔离调用） ─────────────────────────────────
/**
 * 命名调用的模型回复。
 *
 * 它**不需要标记**就能被认出来：命名调用是唯一**不带任何工具**的请求
 * （临时 agent 只有命名指令，见 `runtime/title.service.ts`），mock 据此分流。
 * 刻意与 `MOCK_FINAL_TEXT` 不同、且 ≤10 字，测试才能断言"标题确实来自这一次调用"。
 */
export const MOCK_TITLE_TEXT = '待办整理周报'

/** 用户消息里带这个标记时，逐字慢速输出（用于验证"停止"与"断线补发"） */
export const MOCK_SLOW_MARKER = '[slow]'

/** 一次工具调用的决定（OpenAI 的 tool_calls 形态从这里生成） */
interface MockToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

const TODO_INITIAL_CALL: MockToolCall = {
  id: 'call_mock_todo_initial',
  name: MOCK_TODO_TOOL,
  args: MOCK_TODO_INITIAL as unknown as Record<string, unknown>,
}
const TODO_OVERWRITE_CALL: MockToolCall = {
  id: 'call_mock_todo_overwrite',
  name: MOCK_TODO_TOOL,
  args: MOCK_TODO_OVERWRITE as unknown as Record<string, unknown>,
}
const TODO_REACT_FIRST_CALL: MockToolCall = {
  id: 'call_mock_todo_react_1',
  name: MOCK_TODO_TOOL,
  args: MOCK_TODO_REACT_FIRST as unknown as Record<string, unknown>,
}
const TODO_REACT_SECOND_CALL: MockToolCall = {
  id: 'call_mock_todo_react_2',
  name: MOCK_TODO_TOOL,
  args: MOCK_TODO_REACT_SECOND as unknown as Record<string, unknown>,
}
const DELEGATE_CALL: MockToolCall = {
  id: 'call_mock_delegate',
  name: MOCK_DELEGATE_TOOL,
  args: {
    name: MOCK_SUBAGENT_NAME,
    system_prompt: MOCK_SUBAGENT_PROMPT,
    task: MOCK_SUBAGENT_TASK,
  },
}
const COMMAND_CALL: MockToolCall = {
  id: 'call_mock_command',
  name: MOCK_COMMAND_TOOL,
  args: { command: MOCK_COMMAND },
}

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

const messagesOf = (body: Record<string, unknown>): Array<Record<string, unknown>> =>
  Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []

/** 本轮（含历史）是否已经有工具结果 —— 有就说明"模型已经拿到过工具反馈" */
const hasToolResult = (body: Record<string, unknown>): boolean =>
  messagesOf(body).some((message) => message.role === 'tool')

/** 只把**工具结果**拼起来找标记（工具调用入参里也会出现同样的文字，混在一起会误判） */
const toolResultText = (body: Record<string, unknown>): string =>
  messagesOf(body)
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.stringify(message))
    .join('\n')

const containsResult = (body: Record<string, unknown>, token: string): boolean =>
  toolResultText(body).includes(token)

const wanted = (body: Record<string, unknown>, marker: string): boolean =>
  JSON.stringify(body.messages ?? []).includes(marker)

/**
 * 这一轮该发哪个工具调用 —— 唯一的决策入口（非流式与流式共用，避免两条链路行为漂移）。
 *
 * 返回 null 表示"不发工具调用"（回到文本回答）。
 */
const decideToolCall = (body: Record<string, unknown>): MockToolCall | null => {
  const tools = body.tools
  if (!Array.isArray(tools) || tools.length === 0) return null

  // 命令执行：跑一次拿到工具结论后回到文本回答（与其它标记同一套路）
  if (wanted(body, MOCK_COMMAND_MARKER)) {
    return hasToolResult(body) ? null : COMMAND_CALL
  }
  if (wanted(body, MOCK_DELEGATE_MARKER)) {
    return hasToolResult(body) ? null : DELEGATE_CALL
  }
  if (wanted(body, MOCK_TODO_REACT_MARKER)) {
    // 同一轮内两次提交：第二次要等第一次的结果（它带着 [react-1]）出现
    if (!containsResult(body, MOCK_REACT_FIRST_TOKEN)) return TODO_REACT_FIRST_CALL
    if (!containsResult(body, MOCK_REACT_SECOND_TOKEN)) return TODO_REACT_SECOND_CALL
    return null
  }
  if (wanted(body, MOCK_TODO_OVERWRITE_MARKER)) {
    return containsResult(body, MOCK_OVERWRITE_TOKEN) ? null : TODO_OVERWRITE_CALL
  }
  // 默认：带工具且本轮还没有任何工具结果 → 提交任务清单
  // （业务工具已全部移除，`todo-write` 是当前唯一的通用工具）
  return hasToolResult(body) ? null : TODO_INITIAL_CALL
}

/**
 * 用量（OpenAI 形态）。
 *
 * `prompt_tokens_details.cached_tokens` 刻意给一个非零值：缓存命中是**用户要看的一列**
 * （`cachedInputTokens` → `usage.cacheReadTokens`），早先这条链路只读嵌套字段导致永远是 `null`；
 * mock 里带上它，端到端就能断言"命中数确实一路传到了库里、也下发给前端了"。
 */
const usage = () => ({
  prompt_tokens: 128,
  completion_tokens: 24,
  total_tokens: 152,
  prompt_tokens_details: { cached_tokens: 64 },
})

/** 决定 → OpenAI 的 `tool_calls` 数组 */
const toToolCalls = (call: MockToolCall): unknown[] => [
  {
    index: 0,
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  },
]

const respondJson = (res: ServerResponse, body: Record<string, unknown>): void => {
  const call = decideToolCall(body)
  const message = call
    ? { role: 'assistant', content: null, tool_calls: toToolCalls(call) }
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
          finish_reason: call ? 'tool_calls' : 'stop',
        },
      ],
      usage: usage(),
    }),
  )
}

const sse = (res: ServerResponse, payload: unknown): void => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** 这一轮请求是不是"子 agent 那一轮"（看系统提示词里有没有标记） */
const isChildTurn = (body: Record<string, unknown>): boolean =>
  JSON.stringify(body.messages ?? []).includes(MOCK_CHILD_MARKER)

/**
 * 这一轮请求是不是"会话命名那一轮"：**唯一不带工具**的请求。
 *
 * 命名用的临时 agent 没有工具（与当前 agent 上下文完全隔离），而主 agent / 子 agent 都有；
 * 所以"没有 tools"就是它的指纹，不必在**生产提示词**里塞测试标记。
 */
const isTitleTurn = (body: Record<string, unknown>): boolean =>
  !Array.isArray(body.tools) || body.tools.length === 0

/** 这一轮的最终文本（命名 / 子 agent / 主 agent 各用不同文本，便于断言"文本确实来自那一轮"） */
const finalText = (body: Record<string, unknown>): string => {
  if (isTitleTurn(body)) return MOCK_TITLE_TEXT
  return isChildTurn(body) ? MOCK_CHILD_TEXT : MOCK_FINAL_TEXT
}

const isSlow = (body: Record<string, unknown>): boolean =>
  JSON.stringify(messagesOf(body)).includes(MOCK_SLOW_MARKER)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const respondStream = (res: ServerResponse, body: Record<string, unknown>): void => {
  const call = decideToolCall(body)
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

  if (call) {
    sse(res, {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', tool_calls: toToolCalls(call) },
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
  const listRequests: Array<{ url: string; authorization: string | undefined }> = []
  const server: Server = createServer((req, res) => {
    void (async () => {
      // OpenAI 形态的"列模型"接口：同步链路与连通性测试都打这里
      if (req.method === 'GET' && req.url?.includes('/models')) {
        listRequests.push({
          url: req.url,
          authorization: req.headers.authorization,
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: MOCK_MODEL_LIST }))
        return
      }
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
    listRequests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}
