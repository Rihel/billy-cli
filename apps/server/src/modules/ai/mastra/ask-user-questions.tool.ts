import dedent from 'dedent'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

/**
 * **向用户提问并挂起**（Mastra 原生工具）。
 *
 * 为什么不用我们的工具 DSL：挂起/续跑是 **Mastra 运行时的控制流**（`suspend()` 让本轮结束、
 * `agent.resumeStream()` 从同一条 run 继续），而我们的 `ToolGateway` 会把 `exec` 里的一切异常
 * 兜成"工具失败"。这类交互原语直接走 Mastra 原生工具，边界清楚。
 *
 * 支持三种题型：
 * - `single`：单选（必须给 options）；
 * - `multi`：多选（必须给 options）；
 * - `text`：问答（不给 options）。
 *
 * 一次最多 5 个问题、一批回答后一次续跑；比让模型连问 5 轮省 5 次往返。
 */

const QuestionOptionSchema = z.object({
  label: z.string().min(1).max(40),
  description: z.string().max(120).optional(),
})

const QuestionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'id 用字母开头的英文 / 数字 / 下划线 / 中划线'),
  type: z.enum(['single', 'multi', 'text']).describe('single 单选 / multi 多选 / text 问答'),
  title: z.string().min(1).max(160).describe('问题本身；要具体到用户能直接回答'),
  options: z.array(QuestionOptionSchema).min(2).max(8).optional(),
  required: z.boolean().default(true),
  placeholder: z.string().max(60).optional(),
})

const AskUserQuestionsInputSchema = z.object({
  questions: z.array(QuestionSchema).min(1).max(5),
  /** 与所有工具一致的理由字段（这个工具不走网关，保留给审计 / 日志） */
  reason: z.string().min(4).max(200).optional(),
})

const AskUserQuestionsSuspendSchema = z.object({
  questions: z.array(QuestionSchema).min(1).max(5),
})

const AskUserQuestionsResumeSchema = z.object({
  /**
   * 用户取消整组回答。
   *
   * 为什么不是"取消本轮运行"：取消运行会让模型永远收不到这次工具结果，它就无从知道
   * 用户是"不愿意答"还是"网络断了"。这里把取消当成一次**明确的工具出参**续跑，
   * 模型据此继续推进（官方对 `suspend()` 的续跑方式就是 `resumeStream(resumeData)`；
   * `declineToolCall()` 只适用于 `requireApproval` 的审批挂起）。
   */
  cancelled: z.boolean().optional(),
  answers: z
    .array(
      z.object({
        id: z.string().min(1),
        value: z.union([z.string().max(2000), z.array(z.string().max(200)).max(8)]),
      }),
    )
    .max(5)
    .optional(),
})

type Question = z.infer<typeof QuestionSchema>
type Answer = NonNullable<z.infer<typeof AskUserQuestionsResumeSchema>['answers']>[number]

/**
 * 续跑时的出参：**给模型读的那一段 + 结构化答案**。
 *
 * 为什么不再只返回字符串：时间线要能按题还原"问了什么 / 答了什么"（前端逐题翻看、
 * 审计一眼看懂），纯文本做不到且解析脆弱。模型那边由 `toModelOutput` 只取 `text`，
 * 它看到的形状与以前完全一样。
 */
export interface AskUserAnswerOutput {
  /** 模型读的那段（保留题号 / 多选聚合），同时落库 */
  text: string
  /** 结构化答案：前端按题还原问答记录；取消时为空数组 */
  answers: Answer[]
  /** 用户取消了整组问题（时间线据此把问题卡显示成"已取消"） */
  cancelled?: boolean
}

/** 用户取消整组回答时给模型的结论（明确要求继续，不要换个说法再问一遍） */
const CANCELLED_TEXT = dedent`
  用户取消了这组问题的回答（没有回答任何一项）。
  不要再重复提问或换个说法再问；请基于已有信息继续推进。
  如果确实缺少关键信息，就说明缺什么、会影响什么，并给出可执行的下一步。
`

/** 把结构化答案排成模型能直接读的一段（保留题号 / 多选聚合）。 */
function formatAnswers(questions: Question[], answers: Answer[]): string {
  const byId = new Map(answers.map((answer) => [answer.id, answer.value]))
  const lines = questions.map((question, index) => {
    const value = byId.get(question.id)
    const text = Array.isArray(value) ? value.join('、') : (value ?? '（未回答）')
    return `${index + 1}. ${question.title}\n   ${text}`
  })
  return `用户已回答：\n${lines.join('\n')}`
}

export const askUserQuestionsTool = createTool({
  id: 'ask-user-questions',
  description: dedent`
    向用户提一组问题并等待回答。需要补充信息、确认口径、让用户在方案之间选择时用。
    调用后本轮会挂起，等用户回答再继续；**不要在调用后自己替用户回答**（问题的类型与上限见参数定义）。
  `,
  inputSchema: AskUserQuestionsInputSchema,
  suspendSchema: AskUserQuestionsSuspendSchema,
  resumeSchema: AskUserQuestionsResumeSchema,
  /**
   * 只改"给模型的那一份"：结构化出参落库、给前端还原问答记录，
   * 模型仍只读 `text`（与改造前逐字一致，避免 JSON 噪音抬高 token 与干扰理解）。
   */
  toModelOutput: (output: unknown) =>
    typeof output === 'string'
      ? { type: 'text', value: output }
      : {
          type: 'text',
          value:
            output && typeof output === 'object' && typeof (output as { text?: unknown }).text === 'string'
              ? (output as { text: string }).text
              : '',
        },
  execute: async ({ questions }, context) => {
    // 续跑：Mastra 把上一轮的 suspendPayload 与本轮 resumeData 一起带回来。
    // 兼容两种挂载点：新版本在 context 顶层，内置 ask_user 走 context.agent（实测以 agent 为准）。
    const agentContext = (context as { agent?: Record<string, unknown> } | undefined)?.agent
    const resumeData = (agentContext?.resumeData ??
      context?.resumeData) as z.infer<typeof AskUserQuestionsResumeSchema> | undefined
    // 取消回答：也走"工具正常出参"这条路，让模型拿到明确结论后继续干活
    if (resumeData?.cancelled === true) {
      return {
        text: CANCELLED_TEXT,
        answers: [],
        cancelled: true,
      } satisfies AskUserAnswerOutput
    }
    if (resumeData?.answers?.length) {
      return {
        text: formatAnswers(questions, resumeData.answers),
        answers: resumeData.answers,
      } satisfies AskUserAnswerOutput
    }

    // 正常路径：挂起本轮，把问题交给前端渲染
    const suspend = (agentContext?.suspend ?? context?.suspend) as
      | ((payload: unknown) => Promise<void>)
      | undefined
    if (suspend) {
      await suspend({ questions })
      return
    }

    // 没有 agent 运行时（直接单测 / 后台调用）：不挂起，返回可读的兜底，
    // 让调用方能看见"这里本来要问什么"，而不是静默丢问题。
    return `需要用户回答以下问题（当前调用没有可用的用户界面）：\n${questions
      .map((question, index) => `${index + 1}. ${question.title}`)
      .join('\n')}`
  },
})
