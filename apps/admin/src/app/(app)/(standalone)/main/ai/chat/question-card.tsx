'use client'

import { useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Checkbox,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Textarea,
} from '@repo/ui'

/**
 * 工具挂起后的一张问题卡（`data-tool-call-suspended`）。
 *
 * 不依赖具体的工具名：payload 里是 `questions[]`（我们的批量提问）就按批量渲染；
 * 是单个 `question` + `options`（Mastra 自带 `ask_user`）也能降级成一道题。
 *
 * 交互是**逐题**的：一次只显示一道题，答完当前题才能点「下一题」，并可用
 * 「上一题 / 下一题」来回切换；最后一题上「提交回答」，一次把整组答案交出去
 * （工具的 resume 入参是整组 `answers`，不是单题）。
 *
 * 提交走 {@link onAnswer}：由会话页 POST `/agent/chat/resume`，再用
 * `readUIMessageStream` 把续跑的同一段流并回原消息。
 *
 * 回答完之后，这张卡**不消失**：`resumed=true` 时退化成只读的问答记录
 * （同样逐题翻看），留在时间线里当初的位置上（见 `history.ts`）。
 */

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  id: string
  type: 'single' | 'multi' | 'text'
  title: string
  options?: QuestionOption[]
  required?: boolean
  placeholder?: string
}

export interface QuestionAnswer {
  id: string
  value: string | string[]
}

export interface SuspendedPartData {
  runId?: string
  toolCallId?: string
  toolName?: string
  /** `false` / 缺省 = 还在等回答；`true` = 已经续跑过（历史回放时不再让用户填） */
  resumed?: boolean
  /** 用户取消了整组回答（历史重建 / 续跑后补上）；只读回看时显示为「已取消」 */
  cancelled?: boolean
  /** 已回答的答案（历史重建 / 续跑后补上）；只在只读回看时有意义 */
  answers?: QuestionAnswer[]
  suspendPayload?: {
    questions?: Question[]
    question?: string
    options?: QuestionOption[]
    selectionMode?: 'single_select' | 'multi_select'
  }
}

export interface AnswerQuestionsInput {
  runId: string
  toolCallId?: string
  /** 正常提交：至少一条答案 */
  answers?: QuestionAnswer[]
  /** 用户取消整组回答（不带 answers）：交给模型"继续处理"，而不是取消整轮运行 */
  cancelled?: boolean
}

/** 把两种 payload 统一成 `Question[]`；认不出来返回空数组（未知部分仍会显示协议徽标）。 */
export function questionsOf(data: SuspendedPartData | undefined): Question[] {
  const payload = data?.suspendPayload
  if (!payload) return []
  if (Array.isArray(payload.questions) && payload.questions.length > 0) return payload.questions
  if (typeof payload.question === 'string' && payload.question.trim()) {
    return [
      {
        id: 'q1',
        type: payload.options?.length
          ? payload.selectionMode === 'multi_select'
            ? 'multi'
            : 'single'
          : 'text',
        title: payload.question,
        ...(payload.options?.length ? { options: payload.options } : {}),
        required: true,
      },
    ]
  }
  return []
}

/**
 * 这道题算不算答过（必答判据）：多选看有没有勾，文本 / 单选看去掉空白后非空。
 *
 * 抽成纯函数：题卡的单向推进依赖它，会话里的判定也该只有这一处。
 */
export function isAnswered(question: Question, value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(String(value ?? '').trim())
}

/**
 * 「其他（自行填写）」在单选 / 多选里的哨兵值。
 *
 * 为什么不直接存用户输入的文本：选项选择与自由填写得能互相切换、且"勾了别的项"与
 * "自己写了一段"是两件事。用选项里不可能出现的哨兵值占位，真正的文本单独存。
 */
export const OTHER_OPTION = '\u0000other'

/** 「其他」那一行的文案（单选 / 多选共用，改一处就够） */
export const OTHER_OPTION_LABEL = '其他（自行填写）'

/**
 * 「选中项 + 其他文本」→ 真正提交给模型的答案（纯函数，可单测）。
 *
 * 任何题型都必须能写"模型没给的选项"：
 * - 单选：选中「其他」时答案就是输入框里的文字；否则就是选中的 label；
 * - 多选：勾选项 + （勾了「其他」时的）输入文字，按顺序合成一个数组；
 * - 问答：本身就是文本框，原样返回。
 *
 * 空文本不算作答：单选选了「其他」却没写、多选只勾了「其他」却没写，都会被 `isAnswered`
 * 判成"没答" —— 必答题因此拦住"下一题"，而不是把空字符串当答案交上去。
 */
export const resolveAnswerValue = (
  question: Question,
  value: string | string[] | undefined,
  otherText: string,
): string | string[] => {
  const other = otherText.trim()
  if (question.type === 'multi') {
    const list = Array.isArray(value) ? value : []
    const chosen = list.filter((item) => item !== OTHER_OPTION)
    return list.includes(OTHER_OPTION) && other ? [...chosen, other] : chosen
  }
  if (question.type === 'single') {
    const single = typeof value === 'string' ? value : ''
    return single === OTHER_OPTION ? other : single
  }
  return typeof value === 'string' ? value : ''
}

const typeLabel = (type: Question['type']): string =>
  type === 'single' ? '单选' : type === 'multi' ? '多选' : '问答'

export function QuestionCard({
  data,
  onSubmit,
}: {
  data: SuspendedPartData
  /** 返回 Promise：失败由调用方 toast，卡片保持可编辑 */
  onSubmit?: (input: AnswerQuestionsInput) => Promise<void>
}) {
  const questions = useMemo(() => questionsOf(data), [data])
  const [values, setValues] = useState<Record<string, string | string[]>>({})
  const [index, setIndex] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [cancelledLocally, setCancelledLocally] = useState(false)
  const [error, setError] = useState<string>()
  /** 「其他（自行填写）」的文本（按题目 id 存；与选项选中状态分开，见 `OTHER_OPTION`） */
  const [others, setOthers] = useState<Record<string, string>>({})

  if (questions.length === 0) return null

  const resumed = data.resumed === true
  const cancelled = data.cancelled === true || cancelledLocally
  const readOnly = resumed || submitted || cancelled
  const busy = submitting || cancelling
  const disabled = busy || submitted || resumed
  const current = questions[Math.min(index, questions.length - 1)]!
  const answers = data.answers ?? []
  const isLast = index === questions.length - 1

  /** 已经落库那轮答案（只读回看用）；没有就返回空串 */
  const recordedOf = (question: Question): string => {
    const found = answers.find((answer) => answer.id === question.id)
    if (!found) return ''
    return Array.isArray(found.value) ? found.value.join('、') : found.value
  }

  /** 某道题的当前取值：只读看落库答案，编辑看本地输入 */
  const valueOf = (question: Question): string => {
    if (resumed) return recordedOf(question)
    const value = values[question.id]
    return Array.isArray(value) ? value.join('、') : String(value ?? '')
  }

  /** 「其他」输入框里的原文 */
  const otherTextOf = (id: string): string => others[id] ?? ''

  /** 这道题最终会提交的答案（选项 + 其他文本合一） */
  const answerOf = (question: Question): string | string[] =>
    resolveAnswerValue(question, values[question.id], otherTextOf(question.id))

  /** 这道题是否没答（选填永远算答完，不拦推进） */
  const missing = (question: Question): boolean =>
    question.required !== false && !isAnswered(question, answerOf(question))

  const canGoNext = readOnly || !missing(current)

  const setValue = (id: string, value: string | string[]) => {
    setValues((current) => ({ ...current, [id]: value }))
    setError(undefined)
  }

  const toggleMulti = (id: string, label: string, checked: boolean) => {
    const value = values[id]
    const list = Array.isArray(value) ? value : []
    setValue(id, checked ? [...list, label] : list.filter((item) => item !== label))
  }

  const goPrev = () => {
    if (index === 0) return
    setIndex(index - 1)
    setError(undefined)
  }

  const goNext = () => {
    if (!canGoNext || isLast) return
    setIndex(index + 1)
    setError(undefined)
  }

  const submit = async () => {
    if (!onSubmit) return
    const firstMissing = questions.find((question) => missing(question))
    if (firstMissing) {
      setIndex(questions.indexOf(firstMissing))
      setError(`还有问题没回答：${firstMissing.title}`)
      return
    }
    if (!data.runId) {
      setError('缺少 runId，无法续跑这一轮')
      return
    }
    setSubmitting(true)
    try {
      await onSubmit({
        runId: data.runId,
        ...(data.toolCallId ? { toolCallId: data.toolCallId } : {}),
        answers: questions.map((question) => ({
          id: question.id,
          value: answerOf(question),
        })),
      })
      setSubmitted(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  /**
   * 取消整组回答：不是"停止这一轮"，而是把 `cancelled: true` 作为 resumeData 续跑，
   * 由 `ask-user-questions` 给模型一个明确结论（用户放弃回答），模型继续推进。
   */
  const cancel = async () => {
    if (!onSubmit) return
    if (!data.runId) {
      setError('缺少 runId，无法续跑这一轮')
      return
    }
    setCancelling(true)
    try {
      await onSubmit({
        runId: data.runId,
        ...(data.toolCallId ? { toolCallId: data.toolCallId } : {}),
        cancelled: true,
      })
      setCancelledLocally(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCancelling(false)
    }
  }

  const progressOf = (question: Question, at: number): boolean => {
    if (resumed) return Boolean(recordedOf(question).trim())
    return isAnswered(question, answerOf(question)) || at < index
  }

  return (
    <div className="w-full rounded-lg bg-surface-1 p-3 text-sm">
      <div className="mb-2 flex items-center gap-2">
        <Badge variant="secondary">
          {cancelled
            ? '已取消'
            : resumed
              ? '已回答'
              : submitted
                ? '已回答，正在继续…'
                : '需要你回答'}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {cancelled
            ? `你取消了这 ${questions.length} 个问题，AI 会基于现有信息继续`
            : resumed
              ? `共 ${questions.length} 个问题`
              : `共 ${questions.length} 个问题，逐题回答`}
        </span>
        <div className="ml-auto flex items-center gap-1" aria-hidden>
          {questions.map((question, at) => (
            <span
              key={question.id}
              className={`h-1.5 w-4 rounded-full ${
                at === index
                  ? 'bg-primary'
                  : progressOf(question, at)
                    ? 'bg-muted-foreground/40'
                    : 'bg-muted'
              }`}
            />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <span className="text-xs text-muted-foreground">{index + 1}.</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{current.title}</span>
              <Badge variant="outline" className="text-[10px]">
                {typeLabel(current.type)}
              </Badge>
              {current.required === false ? (
                <span className="text-[10px] text-muted-foreground">选填</span>
              ) : null}
            </div>

            {readOnly ? (
              <div className="mt-2 rounded-md bg-muted/50 px-3 py-2">
                {cancelled ? (
                  <span className="text-muted-foreground">已取消回答</span>
                ) : valueOf(current).trim() ? (
                  <span className="whitespace-pre-wrap">{valueOf(current)}</span>
                ) : (
                  <span className="text-muted-foreground">未回答</span>
                )}
              </div>
            ) : (
              <>
                {current.type === 'single' && current.options?.length ? (
                  <RadioGroup
                    className="mt-2 gap-1.5"
                    value={
                      typeof values[current.id] === 'string' ? (values[current.id] as string) : ''
                    }
                    onValueChange={(value) => setValue(current.id, value)}
                    disabled={disabled}
                  >
                    {current.options.map((option) => (
                      <Label
                        key={option.label}
                        className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
                      >
                        <RadioGroupItem value={option.label} className="mt-0.5" />
                        <span className="min-w-0">
                          <span>{option.label}</span>
                          {option.description ? (
                            <span className="block text-xs text-muted-foreground">
                              {option.description}
                            </span>
                          ) : null}
                        </span>
                      </Label>
                    ))}
                    <Label
                      key="__other__"
                      className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
                    >
                      <RadioGroupItem value={OTHER_OPTION} className="mt-0.5" />
                      <span className="min-w-0">
                        <span>{OTHER_OPTION_LABEL}</span>
                        <span className="block text-xs text-muted-foreground">
                          模型给的选项都不合适时，自己写一段
                        </span>
                      </span>
                    </Label>
                  </RadioGroup>
                ) : null}

                {current.type === 'multi' && current.options?.length ? (
                  <div className="mt-2 grid gap-1.5">
                    {current.options.map((option) => {
                      const list = Array.isArray(values[current.id])
                        ? (values[current.id] as string[])
                        : []
                      return (
                        <Label
                          key={option.label}
                          className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
                        >
                          <Checkbox
                            checked={list.includes(option.label)}
                            onCheckedChange={(checked) =>
                              toggleMulti(current.id, option.label, checked === true)
                            }
                            disabled={disabled}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span>{option.label}</span>
                            {option.description ? (
                              <span className="block text-xs text-muted-foreground">
                                {option.description}
                              </span>
                            ) : null}
                          </span>
                        </Label>
                      )
                    })}
                    <Label
                      key="__other__"
                      className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
                    >
                      <Checkbox
                        checked={
                          Array.isArray(values[current.id]) &&
                          (values[current.id] as string[]).includes(OTHER_OPTION)
                        }
                        onCheckedChange={(checked) => {
                          const list = Array.isArray(values[current.id])
                            ? (values[current.id] as string[])
                            : []
                          const rest = list.filter((item) => item !== OTHER_OPTION)
                          setValue(current.id, checked === true ? [...rest, OTHER_OPTION] : rest)
                        }}
                        disabled={disabled}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span>{OTHER_OPTION_LABEL}</span>
                        <span className="block text-xs text-muted-foreground">
                          模型给的选项都不合适时，自己写一段（可与其他项同时选）
                        </span>
                      </span>
                    </Label>
                  </div>
                ) : null}

                {current.type === 'text' ? (
                  <Textarea
                    className="mt-2 min-h-20"
                    placeholder={current.placeholder ?? '直接写你的回答'}
                    value={
                      typeof values[current.id] === 'string' ? (values[current.id] as string) : ''
                    }
                    onChange={(event) => setValue(current.id, event.target.value)}
                    disabled={disabled}
                  />
                ) : null}

                {/*
                  **兜底输入框**（不论文案与题型来自哪里都有一条）：
                  模型给的选项通常不全，用户必须能写"不在选项里的那个答案"。
                  在这里输入等同于选中「其他」：单选覆盖选中项、多选追加在末尾、清空即取消。
                */}
                {current.type !== 'text' ? (
                  <Input
                    className="mt-2"
                    aria-label={OTHER_OPTION_LABEL}
                    placeholder="不在上面的选项里？直接写在这里"
                    value={otherTextOf(current.id)}
                    onChange={(event) => {
                      const text = event.target.value
                      setOthers((prev) => ({ ...prev, [current.id]: text }))
                      if (current.type === 'single') {
                        setValue(current.id, text ? OTHER_OPTION : '')
                        return
                      }
                      const list = Array.isArray(values[current.id])
                        ? (values[current.id] as string[])
                        : []
                      const rest = list.filter((item) => item !== OTHER_OPTION)
                      setValue(current.id, text ? [...rest, OTHER_OPTION] : rest)
                    }}
                    disabled={disabled}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {readOnly ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => void cancel()}
              disabled={busy || !onSubmit}
            >
              {cancelling ? '取消中…' : '取消回答'}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={goPrev} disabled={index === 0 || busy}>
            上一题
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">
          第 {index + 1} / {questions.length} 题
        </span>
        {isLast ? (
          readOnly ? (
            <span className="text-xs text-muted-foreground">
              {cancelled ? '已取消' : submitted && !resumed ? '已回答，正在继续…' : '已记录'}
            </span>
          ) : (
            <Button size="sm" onClick={() => void submit()} disabled={busy || !onSubmit}>
              {submitting ? '提交中…' : '提交回答'}
            </Button>
          )
        ) : (
          <Button variant="outline" size="sm" onClick={goNext} disabled={busy || !canGoNext}>
            下一题
          </Button>
        )}
      </div>
    </div>
  )
}
