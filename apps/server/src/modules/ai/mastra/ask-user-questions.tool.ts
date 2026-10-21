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
  answers: z
    .array(
      z.object({
        id: z.string().min(1),
        value: z.union([z.string().max(2000), z.array(z.string().max(200)).max(8)]),
      }),
    )
    .min(1)
    .max(5),
})

type Question = z.infer<typeof QuestionSchema>
type Answer = z.infer<typeof AskUserQuestionsResumeSchema>['answers'][number]

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
    一次最多 5 个；type=single（单选，必须给 options）、multi（多选，必须给 options）、text（问答，不给 options）。
    调用后本轮会挂起，等用户回答再继续；**不要在调用后自己替用户回答**。
  `,
  inputSchema: AskUserQuestionsInputSchema,
  suspendSchema: AskUserQuestionsSuspendSchema,
  resumeSchema: AskUserQuestionsResumeSchema,
  execute: async ({ questions }, context) => {
    // 续跑：Mastra 把上一轮的 suspendPayload 与本轮 resumeData 一起带回来。
    // 兼容两种挂载点：新版本在 context 顶层，内置 ask_user 走 context.agent（实测以 agent 为准）。
    const agentContext = (context as { agent?: Record<string, unknown> } | undefined)?.agent
    const resumeData = (agentContext?.resumeData ??
      context?.resumeData) as z.infer<typeof AskUserQuestionsResumeSchema> | undefined
    if (resumeData?.answers?.length) {
      return formatAnswers(questions, resumeData.answers)
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
