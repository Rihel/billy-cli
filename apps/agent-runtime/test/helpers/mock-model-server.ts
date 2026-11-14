import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 离线 mock 模型服务（OpenAI 兼容）：**端到端测试用的假模型**，不依赖任何外部密钥。
 *
 * 行为刻意做得确定，便于断言：
 * 1. 请求里带了工具、且本轮还没有任何工具结果 → 先发一次工具调用（默认 `plan-create`）；
 * 2. 否则 → 回固定文本（代表"拿到工具结果后的最终回答"）。
 *
 * 标记把"多步行为"确定下来（都写在**用户消息**里）：
 * - `[delegate]`：改调 `run-sub-agent`；
 * - `[command]`：改调 `bash`（真跑一条 `echo`，验证跨平台命令执行链路）；
 * - `[no-reason]`：**先故意不发 `reason`**（验证"被拒 → 模型改正后成功"这条纪律闭环）；
 * - `[todo-overwrite]`：发**一串增量规划调用**（`plan-complete` → `plan-create` → `plan-delete`，
 *   依次表达"改状态 / 加任务 / 删任务"；每步等上一步的出参里出现对应标记再发下一个）；
 * - `[todo-react]`：**同一轮内串行两次规划调用**（`plan-create` → `plan-complete`，
 *   第二次的入参里带上第一次新增的任务 —— 证明同轮内串行读改写）。
 *
 * 所有工具调用都带 `reason`（引擎把它做成必填，模型不写就调不动，见设计 §5.18）；
 * 想验"不写会怎样"用 `[no-reason]`。
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
 * 刻意覆盖三种情形，供"同步落模型明细"的测试断言：
 * - 字段齐全（`id` / `created` / `owned_by` 都有，全量进 `raw`）；
 * - 窗口类字段**给了**（DeepSeek 官方 `/models` 的 schema 就带 `name` / `context_window` /
 *   `max_output_tokens` / `input_modalities` / `output_modalities` / `effort`）→ 必须落库，
 *   丢了会静默退回 32K 兜底窗口；
 * - 窗口类字段**没给**（多数厂商还是老形态）→ 同步后必须是 `null`，**不许编造**。
 */
export const MOCK_MODEL_LIST = [
  { id: 'mock-chat', object: 'model', created: 1700000000, owned_by: 'mock-vendor' },
  { id: 'mock-reasoner', object: 'model', created: 1700000001, owned_by: 'mock-vendor' },
  /**
   * 第三个带上**模态 + 规格声明**（DeepSeek 官方形态）：
   * 用它验证"供应商给了就落库"，而前两个验证"没给就是未声明（不编造）"。
   */
  {
    id: 'mock-vision',
    object: 'model',
    created: 1700000002,
    owned_by: 'mock-vendor',
    name: 'Mock Vision',
    context_window: 131_072,
    max_output_tokens: 8_192,
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
    effort: { supported_levels: ['low', 'high'], default_level: 'high' },
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  },
]

/** 固定回复文本（断言用） */
export const MOCK_FINAL_TEXT = '好，清单已经记下，我按步骤继续推进。'

// ── 调用理由（`reason`：引擎注入的必填字段，见设计 §5.18） ──────────────────
/**
 * 每个工具调用都要带的 `reason` —— **不给就该被拒**（引擎把它做成了必填）。
 *
 * mock 一律带上它：真实模型会被要求说明"为什么这次要用这个工具"。
 */
export const MOCK_REASON = '按用户要求推进这一步'
/** 用户消息里带这个标记时：第一次调用**故意不写 reason**（验证"被拒 → 改正后成功"） */
export const MOCK_NO_REASON_MARKER = '[no-reason]'
/** 改正后那次调用写的理由（断言它进了时间线 / 审计） */
export const MOCK_NO_REASON_FIXED = '刚才漏了说明理由，这次补上：按用户要求跑这一步'

// ── 任务清单（规划工具集：plan-create / plan-reorder / plan-complete / plan-delete）──────
/**
 * 规划工具集里 mock 用到的工具 key。
 *
 * 规划能力现在是一组**增量工具**（出参永远是完整清单快照，见 `runtime/plan.protocol.ts`）：
 * mock 只能发它"认得"的工具名，所以逐个列出来；默认发 `plan-create`。
 */
export const MOCK_PLAN_CREATE_TOOL = 'plan-create'
export const MOCK_PLAN_REORDER_TOOL = 'plan-reorder'
export const MOCK_PLAN_COMPLETE_TOOL = 'plan-complete'
export const MOCK_PLAN_DELETE_TOOL = 'plan-delete'

/** 默认的首次调用：`plan-create` 建一份清单（一次建多个，id 由模型给） */
export const MOCK_PLAN_INITIAL = {
  goal: '把待办整理成周报',
  tasks: [
    { id: 't1', title: '取最近的待办', status: 'in_progress' },
    { id: 't2', title: '按主题分组', status: 'pending' },
  ],
}

/** 用户消息里带这个标记时：先调 `ask-user-questions` 挂起，续跑后回固定文本 */
export const MOCK_ASK_MARKER = '[ask]'
/** 问题工具（Mastra 原生工具；不经过我们的工具注册机） */
export const MOCK_ASK_TOOL = 'ask-user-questions'
export const MOCK_ASK_QUESTIONS = [
  {
    id: 'audience',
    type: 'single',
    title: '这份给谁看？',
    options: [{ label: '长辈自己' }, { label: '子女看了去教' }],
    required: true,
  },
  {
    id: 'topics',
    type: 'multi',
    title: '先教哪几件？',
    options: [{ label: '接电话' }, { label: '发微信' }],
    required: true,
  },
]

/** 用户消息里带这个标记时，发一串增量调用（验证 create 追加 / reorder 改状态 / delete 删除） */
export const MOCK_PLAN_OVERWRITE_MARKER = '[todo-overwrite]'
/** 覆盖序列里新增任务的标题标记（用来判断"这一步已经提交过了"） */
export const MOCK_OVERWRITE_TOKEN = '[覆盖]'
/**
 * 覆盖序列第 1 步的落地标记。
 *
 * 刻意选**单调**的摘要片段（`plan-complete` 之后每一版快照里都写着"已完成 1 项"）：
 * 若用"t1 in_progress→completed"这种只在当步摘要里出现的串，后面的步骤会把最近一次结果换成
 * 新快照，第 1 步的判定又变回"没做"，于是无限重发同一个调用（还会撞上 tool_call 唯一索引）。
 */
export const MOCK_OVERWRITE_COMPLETE_TOKEN = '已完成 1 项'
/** 覆盖序列第 3 步的判断标记：t2 还在清单里（用它的标题串；被删掉后这条串就不再出现） */
export const MOCK_OVERWRITE_KEEP_T2_TOKEN = '按主题分组'

/**
 * 覆盖序列第 2 步：**追加** t3（`goal` 省略 = 沿用当前目标；已有任务不受影响）。
 *
 * 这一版刻意不再"整份重写"：加、改、删各由一次增量调用表达。
 */
export const MOCK_PLAN_OVERWRITE_ADD = {
  tasks: [{ id: 't3', title: `补充核对口径 ${MOCK_OVERWRITE_TOKEN}` }],
}

/**
 * 覆盖序列跑完后的**当前计划**（时间线最后一条 `plan` 事件）。
 *
 * t1 变 completed、t3 新增（默认 pending）、**t2 被 plan-delete 删掉**，目标沿用未改。
 * `revision` = 初始 1 + 三步各 +1 = 4。
 */
export const MOCK_PLAN_OVERWRITE_FINAL = {
  goal: MOCK_PLAN_INITIAL.goal,
  revision: 4,
  tasks: [
    { id: 't1', title: '取最近的待办', status: 'completed' },
    { id: 't3', title: `补充核对口径 ${MOCK_OVERWRITE_TOKEN}`, status: 'pending' },
  ],
}

/** 用户消息里带这个标记时：同一轮内串行两次规划调用（验证同轮内能读到彼此的结果） */
export const MOCK_PLAN_REACT_MARKER = '[todo-react]'
/** 第一次调用新增的任务标题标记 */
export const MOCK_REACT_FIRST_TOKEN = '[react-1]'
/** 第二次调用写进备注的标记 */
export const MOCK_REACT_SECOND_TOKEN = '[react-2]'
/** 同一轮内的第一次调用：`plan-create` 建一份新清单，新增 r2 */
export const MOCK_PLAN_REACT_FIRST = {
  goal: '整理评审材料',
  tasks: [
    { id: 'r1', title: '起草初稿', status: 'completed' },
    { id: 'r2', title: `补充数据 ${MOCK_REACT_FIRST_TOKEN}`, status: 'in_progress' },
  ],
}
/**
 * 同一轮内的第二次调用：**入参里带着第一次新增的 r2**（用 `ids` 引用它），并把它标成完成。
 *
 * 运行时在整轮结束后才落 `plan` 事件，所以第二次能算出"比第一次更大的 revision"，
 * 只可能是因为它读到了第一次在本轮内存里留下的结果 —— 这就是"react 循环里能调整清单"的硬证明。
 */
export const MOCK_PLAN_REACT_SECOND = {
  ids: ['r2'],
  note: `交叉校验 ${MOCK_REACT_SECOND_TOKEN}`,
}
/** 两次调用之后的**当前计划**（时间线最后一条 `plan` 事件）：r2 完成，备注里带着 [react-2] */
export const MOCK_PLAN_REACT_FINAL = {
  goal: '整理评审材料',
  revision: 2,
  tasks: [
    { id: 'r1', title: '起草初稿', status: 'completed' },
    {
      id: 'r2',
      title: `补充数据 ${MOCK_REACT_FIRST_TOKEN}`,
      status: 'completed',
      note: `交叉校验 ${MOCK_REACT_SECOND_TOKEN}`,
    },
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
export const MOCK_COMMAND_TOOL = 'bash'
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

/** 用户消息里带这个标记时，模型**一步**派出 4 个子 agent（验证并行执行与"同时最多 3 个"的闸门） */
export const MOCK_DELEGATE_PARALLEL_MARKER = '[delegate-parallel]'

/**
 * 并行子助手的提示词：带 `[child]` 让 mock 认出是子 agent，带 `[slow]` 让每个孩子
 * 跑得够久（逐字 40ms），测试才能从运行区间上量出"真的重叠、且不超过 3"。
 */
const MOCK_SUBAGENT_PROMPT_SLOW = `你是并行测试子助手 ${MOCK_CHILD_MARKER} ${MOCK_SLOW_MARKER}：只做统计，输出结论与口径。`

// ── 工具自定义事件 ─────────────────────────────────────────────────────────
/** 用户消息里带这个标记时，模型改为调用「事件演示工具」（验证 `data-tool-event` 这条链路） */
export const MOCK_EVENTS_MARKER = '[events]'
/** 事件演示工具 key（由测试专用工具组 `tool-event-testkit` 交出，**不进生产装配**） */
export const MOCK_EVENTS_TOOL = 'test-event-tool'
/** 状态事件的载荷（断言"后发的覆盖先发的"用最后一个值） */
export const MOCK_EVENT_PROGRESS = { state: 'done', percent: 100 }
/** 流水事件的载荷（断言统一事件名不带 id、逐条追加） */
export const MOCK_EVENT_LINE = '事件演示的流水行'

/** 一次工具调用的决定（OpenAI 的 tool_calls 形态从这里生成） */
interface MockToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

const PLAN_INITIAL_CALL: MockToolCall = {
  id: 'call_mock_plan_initial',
  name: MOCK_PLAN_CREATE_TOOL,
  args: { ...(MOCK_PLAN_INITIAL as unknown as Record<string, unknown>), reason: MOCK_REASON },
}
/** 覆盖序列第 1 步：把原 t1 标完成 */
const PLAN_OVERWRITE_COMPLETE_CALL: MockToolCall = {
  id: 'call_mock_plan_overwrite_complete',
  name: MOCK_PLAN_COMPLETE_TOOL,
  args: { ids: ['t1'], reason: MOCK_REASON },
}
/** 覆盖序列第 2 步：追加 t3（goal 省略 = 沿用当前目标） */
const PLAN_OVERWRITE_ADD_CALL: MockToolCall = {
  id: 'call_mock_plan_overwrite_add',
  name: MOCK_PLAN_CREATE_TOOL,
  args: { ...(MOCK_PLAN_OVERWRITE_ADD as unknown as Record<string, unknown>), reason: MOCK_REASON },
}
/** 覆盖序列第 3 步：删掉 t2 */
const PLAN_OVERWRITE_DELETE_CALL: MockToolCall = {
  id: 'call_mock_plan_overwrite_delete',
  name: MOCK_PLAN_DELETE_TOOL,
  args: { ids: ['t2'], reason: MOCK_REASON },
}
const PLAN_REACT_FIRST_CALL: MockToolCall = {
  id: 'call_mock_plan_react_1',
  name: MOCK_PLAN_CREATE_TOOL,
  args: { ...(MOCK_PLAN_REACT_FIRST as unknown as Record<string, unknown>), reason: MOCK_REASON },
}
const PLAN_REACT_SECOND_CALL: MockToolCall = {
  id: 'call_mock_plan_react_2',
  name: MOCK_PLAN_COMPLETE_TOOL,
  args: { ...(MOCK_PLAN_REACT_SECOND as unknown as Record<string, unknown>), reason: MOCK_REASON },
}
const DELEGATE_CALL: MockToolCall = {
  id: 'call_mock_delegate',
  name: MOCK_DELEGATE_TOOL,
  args: {
    name: MOCK_SUBAGENT_NAME,
    system_prompt: MOCK_SUBAGENT_PROMPT,
    task: MOCK_SUBAGENT_TASK,
    reason: MOCK_REASON,
  },
}
/** 一步派 4 个子助手：并发闸门是 3，第 4 个必须等前面有一个跑完 */
const DELEGATE_PARALLEL_CALLS: MockToolCall[] = Array.from({ length: 4 }, (_, index) => ({
  id: `call_mock_delegate_parallel_${index + 1}`,
  name: MOCK_DELEGATE_TOOL,
  args: {
    name: `并行子助手${index + 1}`,
    system_prompt: MOCK_SUBAGENT_PROMPT_SLOW,
    task: `${MOCK_SUBAGENT_TASK}（第 ${index + 1} 路）`,
    reason: MOCK_REASON,
  },
}))
const COMMAND_CALL: MockToolCall = {
  id: 'call_mock_command',
  name: MOCK_COMMAND_TOOL,
  args: { command: MOCK_COMMAND, reason: MOCK_REASON },
}
const ASK_CALL: MockToolCall = {
  id: 'call_mock_ask',
  name: MOCK_ASK_TOOL,
  args: { questions: MOCK_ASK_QUESTIONS, reason: MOCK_REASON },
}
/** 事件演示：跑一次会把"状态快照 + 流水行"写进父流（断言 SSE 里出现 `data-tool-event`） */
const EVENTS_CALL: MockToolCall = {
  id: 'call_mock_events',
  name: MOCK_EVENTS_TOOL,
  args: { keyword: MOCK_EVENT_LINE, reason: MOCK_REASON },
}
/** 漏写 reason 的那一次（`reason` 给了空串：模型"写了字段但没说清"的最常见形态） */
const COMMAND_NO_REASON_CALL: MockToolCall = {
  id: 'call_mock_command_no_reason',
  name: MOCK_COMMAND_TOOL,
  args: { command: MOCK_COMMAND, reason: '' },
}
/** 被拒之后改正的那一次：同一件事，这次理由写清楚了 */
const COMMAND_RETRY_REASON_CALL: MockToolCall = {
  id: 'call_mock_command_retry_reason',
  name: MOCK_COMMAND_TOOL,
  args: { command: MOCK_COMMAND, reason: MOCK_NO_REASON_FIXED },
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

/** 最近一次工具结果的原文（"上一步"的判定只看它） */
const latestToolResultText = (body: Record<string, unknown>): string | null => {
  const results = messagesOf(body).filter((message) => message.role === 'tool')
  if (results.length === 0) return null
  return JSON.stringify(results[results.length - 1])
}

/**
 * **最近一次**工具结果里有没有某个标记串 —— 多步序列靠它判断"上一步做完了没有"。
 *
 * 为什么只看最近一次：规划工具的出参是**完整清单快照**，历史结果里也有老任务
 * （如 t2 的标题），扫全部结果会把"t2 已经删掉了"误判成"t2 还在"，于是无限重发删除调用。
 * 标记串一律选**不含引号**的片段，避免 `JSON.stringify` 把引号转义掉。
 */
const containsResult = (body: Record<string, unknown>, token: string): boolean =>
  latestToolResultText(body)?.includes(token) ?? false

const wanted = (body: Record<string, unknown>, marker: string): boolean =>
  JSON.stringify(body.messages ?? []).includes(marker)

/** 一个 mock 服务实例内的短期状态（跨请求要记住"这条已经发过几次"） */
interface MockServerState {
  /** `[no-reason]` 已经发过的次数（1 = 那条故意的坏调用已经发了，下一次要改正） */
  noReasonCalls: number
}

/**
 * `[no-reason]`：**第一次故意不写 reason**（空串 = "写了字段但没说清"），之后改正。
 *
 * 只用请求里的消息判定（不靠进程级全局）：第一次没有任何工具结果 → 发坏的那条；
 * 有工具结果（那次拒绝会以 `tool` 角色的错误结果回到模型）→ 发改正后的那条。
 */
const decideNoReasonCall = (
  body: Record<string, unknown>,
  state: MockServerState,
): MockToolCall | null => {
  if (!hasToolResult(body) && state.noReasonCalls === 0) {
    state.noReasonCalls += 1
    return COMMAND_NO_REASON_CALL
  }
  if (state.noReasonCalls === 1 && latestToolResultText(body)?.includes('reason')) {
    state.noReasonCalls += 1
    return COMMAND_RETRY_REASON_CALL
  }
  return null
}

/**
 * 这一轮该发哪个工具调用 —— 唯一的决策入口（非流式与流式共用，避免两条链路行为漂移）。
 *
 * 返回 null 表示"不发工具调用"（回到文本回答）。
 */
const decideToolCall = (
  body: Record<string, unknown>,
  state: MockServerState,
): MockToolCall | null => {
  const tools = body.tools
  if (!Array.isArray(tools) || tools.length === 0) return null

  // 纪律闭环：漏写 reason → 被拒 → 模型改正后成功（设计 §5.18）
  if (wanted(body, MOCK_NO_REASON_MARKER)) {
    return decideNoReasonCall(body, state)
  }
  // 命令执行：跑一次拿到工具结论后回到文本回答（与其它标记同一套路）
  if (wanted(body, MOCK_COMMAND_MARKER)) {
    return hasToolResult(body) ? null : COMMAND_CALL
  }
  if (wanted(body, MOCK_EVENTS_MARKER)) {
    return hasToolResult(body) ? null : EVENTS_CALL
  }
  if (wanted(body, MOCK_DELEGATE_MARKER)) {
    return hasToolResult(body) ? null : DELEGATE_CALL
  }
  if (wanted(body, MOCK_PLAN_REACT_MARKER)) {
    // 同一轮内串行两次：第二次要等第一次新增的 r2（带着 [react-1]）出现在上一步结果里
    if (!containsResult(body, MOCK_REACT_FIRST_TOKEN)) return PLAN_REACT_FIRST_CALL
    if (!containsResult(body, MOCK_REACT_SECOND_TOKEN)) return PLAN_REACT_SECOND_CALL
    return null
  }
  if (wanted(body, MOCK_PLAN_OVERWRITE_MARKER)) {
    // 一串增量调用表达"改状态 / 加任务 / 删任务"：每一步都以上一步的出参（完整清单快照）为准
    if (!containsResult(body, MOCK_OVERWRITE_COMPLETE_TOKEN)) return PLAN_OVERWRITE_COMPLETE_CALL
    if (!containsResult(body, MOCK_OVERWRITE_TOKEN)) return PLAN_OVERWRITE_ADD_CALL
    if (containsResult(body, MOCK_OVERWRITE_KEEP_T2_TOKEN)) return PLAN_OVERWRITE_DELETE_CALL
    return null
  }
  // 问题工具：第一次发 ask-user-questions（会挂起）；续跑请求里已有工具结果 → 回文本
  if (wanted(body, MOCK_ASK_MARKER)) {
    return hasToolResult(body) ? null : ASK_CALL
  }
  // 默认：带工具且本轮还没有任何工具结果 → 建一份任务清单
  // （业务工具已全部移除，规划工具集是当前唯一会主动调用的运行时能力）
  return hasToolResult(body) ? null : PLAN_INITIAL_CALL
}

/**
 * 这一轮要发的全部工具调用（0..n 条）。
 *
 * 只有 `[delegate-parallel]` 会一次发多条（验证子 agent 并行）；其余仍走单条决策，
 * 避免两条链路的行为分叉。
 */
const decideToolCalls = (body: Record<string, unknown>, state: MockServerState): MockToolCall[] => {
  if (wanted(body, MOCK_DELEGATE_PARALLEL_MARKER)) {
    return hasToolResult(body) ? [] : DELEGATE_PARALLEL_CALLS
  }
  const call = decideToolCall(body, state)
  return call ? [call] : []
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

/** 决定 → OpenAI 的 `tool_calls` 数组（一步可以有多条，index 递增） */
const toToolCalls = (calls: readonly MockToolCall[]): unknown[] =>
  calls.map((call, index) => ({
    index,
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }))

const respondJson = (
  res: ServerResponse,
  body: Record<string, unknown>,
  state: MockServerState,
): void => {
  const calls = decideToolCalls(body, state)
  const message =
    calls.length > 0
      ? { role: 'assistant', content: null, tool_calls: toToolCalls(calls) }
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
          finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
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

/** 记忆抽取那一轮的指纹：隔离 agent 的指令里有这个短语（与命名一样不带工具） */
const MEMORY_EXTRACT_MARKER = '长期记忆抽取器'
export const MOCK_MEMORY_EXTRACT_TEXT =
  '[{"kind":"preference","content":"偏好简短回答","key":"reply-style"}]'

const isMemoryExtractTurn = (body: Record<string, unknown>): boolean =>
  JSON.stringify(body.messages ?? []).includes(MEMORY_EXTRACT_MARKER)

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
  if (isMemoryExtractTurn(body)) return MOCK_MEMORY_EXTRACT_TEXT
  if (isTitleTurn(body)) return MOCK_TITLE_TEXT
  return isChildTurn(body) ? MOCK_CHILD_TEXT : MOCK_FINAL_TEXT
}

const isSlow = (body: Record<string, unknown>): boolean =>
  JSON.stringify(messagesOf(body)).includes(MOCK_SLOW_MARKER)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const respondStream = (
  res: ServerResponse,
  body: Record<string, unknown>,
  state: MockServerState,
): void => {
  const calls = decideToolCalls(body, state)
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

  if (calls.length > 0) {
    sse(res, {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', tool_calls: toToolCalls(calls) },
          finish_reason: null,
        },
      ],
    })
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  } else {
    sse(res, {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    })
    const slow = isSlow(body)
    const text = finalText(body)
    const deltas = slow
      ? sseSlow(res, base, text)
      : (() => {
          for (const char of text) {
            sse(res, {
              ...base,
              choices: [{ index: 0, delta: { content: char }, finish_reason: null }],
            })
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
  for (const char of text) {
    if (res.writableEnded) return
    sse(res, { ...base, choices: [{ index: 0, delta: { content: char }, finish_reason: null }] })
    await sleep(40)
  }
}

/** 启动 mock 服务（端口随机，避免与本机其它服务冲突） */
export const startMockModelServer = async (): Promise<MockModelServer> => {
  const requests: Array<Record<string, unknown>> = []
  const listRequests: Array<{ url: string; authorization: string | undefined }> = []
  /** 跨请求的短期状态（`[no-reason]` 要说清"这条已经发过几次"） */
  const state: MockServerState = { noReasonCalls: 0 }
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
      if (body.stream === true) respondStream(res, body, state)
      else respondJson(res, body, state)
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
