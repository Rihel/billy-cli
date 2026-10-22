'use client'

import { useMemo, useState } from 'react'
import { Badge, Button, Checkbox, Label, RadioGroup, RadioGroupItem, Textarea } from '@repo/ui'

/**
 * 工具挂起后的一张问题卡（`data-tool-call-suspended`）。
 *
 * 不依赖具体的工具名：payload 里是 `questions[]`（我们的批量提问）就按批量渲染；
 * 是单个 `question` + `options`（Mastra 自带 `ask_user`）也能降级成一道题。
 *
 * 提交走 {@link onAnswer}：由会话页 POST `/agent/chat/resume`，再用
 * `readUIMessageStream` 把续跑的同一段流并回原消息。
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
  answers: QuestionAnswer[]
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
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string>()

  if (questions.length === 0) return null

  const disabled = submitting || submitted || data.resumed === true

  const setValue = (id: string, value: string | string[]) => {
    setValues((current) => ({ ...current, [id]: value }))
    setError(undefined)
  }

  const toggleMulti = (id: string, label: string, checked: boolean) => {
    const current = values[id]
    const list = Array.isArray(current) ? current : []
    setValue(id, checked ? [...list, label] : list.filter((item) => item !== label))
  }

  const submit = async () => {
    if (!onSubmit) return
    const missing = questions.find((question) => {
      if (question.required === false) return false
      const value = values[question.id]
      return Array.isArray(value) ? value.length === 0 : !String(value ?? '').trim()
    })
    if (missing) {
      setError(`还有问题没回答：${missing.title}`)
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
          value: values[question.id] ?? (question.type === 'multi' ? [] : ''),
        })),
      })
      setSubmitted(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="w-full rounded-lg bg-surface-1 p-3 text-sm">
      <div className="mb-2 flex items-center gap-2">
        <Badge variant="secondary">需要你回答</Badge>
        <span className="text-xs text-muted-foreground">
          {questions.length} 个问题，一次答完继续
        </span>
      </div>

      <div className="space-y-4">
        {questions.map((question, index) => (
          <div key={question.id} className="space-y-2">
            <div className="flex items-start gap-2">
              <span className="text-xs text-muted-foreground">{index + 1}.</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{question.title}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {typeLabel(question.type)}
                  </Badge>
                  {question.required === false ? (
                    <span className="text-[10px] text-muted-foreground">选填</span>
                  ) : null}
                </div>

                {question.type === 'single' && question.options?.length ? (
                  <RadioGroup
                    className="mt-2 gap-1.5"
                    value={typeof values[question.id] === 'string' ? (values[question.id] as string) : ''}
                    onValueChange={(value) => setValue(question.id, value)}
                    disabled={disabled}
                  >
                    {question.options.map((option) => (
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
                  </RadioGroup>
                ) : null}

                {question.type === 'multi' && question.options?.length ? (
                  <div className="mt-2 grid gap-1.5">
                    {question.options.map((option) => {
                      const list = Array.isArray(values[question.id])
                        ? (values[question.id] as string[])
                        : []
                      return (
                        <Label
                          key={option.label}
                          className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
                        >
                          <Checkbox
                            checked={list.includes(option.label)}
                            onCheckedChange={(checked) =>
                              toggleMulti(question.id, option.label, checked === true)
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
                  </div>
                ) : null}

                {question.type === 'text' ? (
                  <Textarea
                    className="mt-2 min-h-20"
                    placeholder={question.placeholder ?? '直接写你的回答'}
                    value={typeof values[question.id] === 'string' ? (values[question.id] as string) : ''}
                    onChange={(event) => setValue(question.id, event.target.value)}
                    disabled={disabled}
                  />
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}

      <div className="mt-3 flex items-center justify-end gap-2">
        {submitted || data.resumed ? (
          <span className="text-xs text-muted-foreground">已回答，正在继续…</span>
        ) : (
          <Button size="sm" onClick={submit} disabled={disabled || !onSubmit}>
            {submitting ? '提交中…' : '提交回答'}
          </Button>
        )}
      </div>
    </div>
  )
}
