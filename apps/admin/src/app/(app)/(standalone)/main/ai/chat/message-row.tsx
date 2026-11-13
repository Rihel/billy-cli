'use client'

import { memo, useMemo } from 'react'
import { PromptAttachments, cn, useStorageAdapter } from '@repo/ui'
import type { PromptAttachmentItem } from '@repo/ui'
import {
  Message,
  MessageActions,
  MessageContent,
  MessageResponse,
} from '@repo/ui/components/ai-elements/message.tsx'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@repo/ui/components/ai-elements/reasoning.tsx'
import { Shimmer } from '@repo/ui/components/ai-elements/shimmer.tsx'
import { ToolCard } from './tool-card'
import { ToolEventCard, ToolEventsBody } from './tool-event'
import { QuestionCard, type AnswerQuestionsInput } from './question-card'
import { MessageCopyMenu } from './message-copy'
import { PlanSummaryCard } from './plan-summary-card'
import { SubAgentCard } from './sub-agent-card'
import { mergeSubAgent } from './sub-agent-live'
import type { ChatMessageState, ChatUnit } from './chat-session'
import { useLiveSubAgent } from './chat-session'
import { useElapsedSeconds } from './use-elapsed'

/**
 * 一条消息：**直接渲染归约好的单元**，不在渲染期扫 parts。
 *
 * 2026-11-03 之前这里是"按 parts 渲染"：每帧都要扫 4–6 遍 parts（计划收集 / 事件分桶 /
 * 子助手收集 / 委派去重）并生成同样长度的 children 数组。parts 里绝大多数是数据块
 * （子助手增量、状态、用量），一条消息能到数万条 —— 页面因此卡死。
 *
 * 现在：parts → `ChatUnit[]` 的归约在 `chat-session.ts` 里按 type 增量完成，组件只吃单元。
 * 行级 `memo`：消息状态对象没变（没新内容）就不重渲染；子助手卡自己订阅实时数据，
 * 所以实时增量不会让整行（更不会让整个列表）重渲染。
 */

/** 附件信息 → `PromptAttachments` 需要的形状（地址在渲染时才拼） */
const toAttachmentItems = (
  files: ChatMessageState['files'],
  resolveUrl: (key: string) => string,
  messageId: string,
): PromptAttachmentItem[] =>
  files.map((file, index) => {
    const previewUrl = file.url || (file.key ? resolveUrl(file.key) : '')
    return {
      key: file.key ?? `${messageId}-file-${index}`,
      filename: file.filename ?? '未命名文件',
      mediaType: file.mediaType ?? '',
      ...(file.bytes !== undefined ? { bytes: file.bytes } : {}),
      ...(previewUrl ? { previewUrl } : {}),
    } as PromptAttachmentItem
  })

/** 子助手单元：快照（来自 part）打底，实时数据覆盖（实时更全、更新） */
function SubAgentUnit({
  runId,
  snapshot,
}: {
  runId: string
  snapshot: Parameters<typeof mergeSubAgent>[0]
}) {
  const live = useLiveSubAgent(runId)
  return <SubAgentCard agent={mergeSubAgent(snapshot, live)} />
}

/** 一个渲染单元 → 一个可见块 */
function ChatUnitView({
  unit,
  streaming,
  showTrailingCards,
  ownedToolCalls,
  isUser,
  onAnswerQuestions,
}: {
  unit: ChatUnit
  streaming: boolean
  showTrailingCards: boolean
  /** 这一条消息里已有工具卡的 toolCallId：事件已被认领，不再单独成卡 */
  ownedToolCalls: ReadonlySet<string>
  isUser: boolean
  onAnswerQuestions?: (input: AnswerQuestionsInput) => Promise<void>
}) {
  /**
   * 思考运行中按**整秒**跳动（与工具卡同一套计时口径：秒边界翻字，不每帧抖）。
   * 传给 `ReasoningTrigger` 的只有"运行中"这一种情况；结束时交回默认文案（"思考了 N 秒"）。
   */
  const thinkingSeconds = useElapsedSeconds(
    unit.kind === 'reasoning' && unit.streaming && streaming,
  )

  switch (unit.kind) {
    case 'text':
      // 用户消息保持纯文本（不走 Markdown：用户打什么就显示什么）
      return isUser ? (
        <p className="whitespace-pre-wrap">{unit.text}</p>
      ) : (
        <MessageResponse isAnimating={streaming && unit.streaming}>{unit.text}</MessageResponse>
      )
    case 'reasoning':
      return (
        <Reasoning
          isStreaming={streaming && unit.streaming}
          {...(unit.durationMs !== undefined
            ? {
                // 与实时收尾同一口径（`Reasoning` 内部也是 ceil）：历史与当场看到的秒数不该差一秒
                duration: Math.max(1, Math.ceil(unit.durationMs / 1000)),
              }
            : {})}
        >
          <ReasoningTrigger
            {...(streaming && unit.streaming && thinkingSeconds !== null
              ? {
                  getThinkingMessage: () => (
                    <Shimmer duration={1}>{`思考中… ${thinkingSeconds}s`}</Shimmer>
                  ),
                }
              : {})}
          />
          <ReasoningContent>{unit.text}</ReasoningContent>
        </Reasoning>
      )
    case 'tool':
      // 委派 / 计划 / 问答工具由对应的卡片代表；它们发出的事件仍要看得见
      if (unit.delegated || unit.hidden) {
        return unit.events.length > 0 ? (
          <ToolEventsBody toolKey={unit.part.toolName} parts={unit.events} />
        ) : null
      }
      return (
        <ToolCard
          part={
            {
              type: 'dynamic-tool',
              toolName: unit.part.toolName,
              toolCallId: unit.part.toolCallId,
              state: unit.part.state,
              input: unit.part.input,
              output: unit.part.output,
              ...(unit.part.errorText ? { errorText: unit.part.errorText } : {}),
            } as never
          }
          events={unit.events}
          defaultOpen={false}
          streaming={streaming}
          {...(unit.part.durationMs !== undefined ? { durationMs: unit.part.durationMs } : {})}
        />
      )
    case 'question':
      // 待回答的问题卡固定在输入框上方（dock），消息流里不再重复；已回答的留在原位当记录
      if (unit.data.resumed !== true && !showTrailingCards) return null
      return (
        <QuestionCard
          data={unit.data}
          {...(onAnswerQuestions ? { onSubmit: onAnswerQuestions } : {})}
        />
      )
    case 'sub-agent':
      return <SubAgentUnit runId={unit.runId} snapshot={unit.snapshot} />
    case 'event': {
      const owner = unit.part.data.toolCallId
      if (owner && ownedToolCalls.has(owner)) return null
      return <ToolEventCard part={unit.part} />
    }
    case 'unknown':
      // 未知 part 类型显式露出来：协议演进时"看得见"比"静默丢掉"好排障
      return (
        <span className="text-xs text-muted-foreground">
          <span className="rounded-md border px-1.5 py-0.5">{unit.partType}</span>
        </span>
      )
    default:
      return null
  }
}

export interface ChatMessageProps {
  message: ChatMessageState
  streaming: boolean
  onOpenPlan?: () => void
  onPreviewImage?: (items: readonly PromptAttachmentItem[], index: number) => void
  onAnswerQuestions?: (input: AnswerQuestionsInput) => Promise<void>
  /**
   * 是否渲染"计划卡 / 问题卡"这类悬浮卡：会话主区关掉（固定在输入框上方），
   * 右栏的历史预览保留默认的 true。
   */
  showTrailingCards?: boolean
}

export const ChatMessage = memo(function ChatMessage({
  message,
  streaming,
  onOpenPlan,
  onPreviewImage,
  onAnswerQuestions,
  showTrailingCards = true,
}: ChatMessageProps) {
  const isUser = message.role === 'user'
  const { resolveUrl } = useStorageAdapter()
  const attachments = toAttachmentItems(message.files, resolveUrl, message.id)
  const ownedToolCalls = useMemo(() => {
    const owned = new Set<string>()
    for (const unit of message.units) {
      if (unit.kind === 'tool') owned.add(unit.part.toolCallId)
    }
    return owned
  }, [message.units])

  return (
    <Message from={message.role} className="max-w-full gap-1.5">
      <MessageContent
        className={cn(
          'gap-1.5 group-[.is-user]:px-3 group-[.is-user]:py-2',
          // 助手侧内容铺满整行（工具条 / 子助手卡 / 事件条都是整行的条）
          !isUser && 'w-full',
        )}
      >
        {message.files.length > 0 ? (
          <PromptAttachments items={attachments} {...(onPreviewImage ? { onPreviewImage } : {})} />
        ) : null}
        {message.units.map((unit) => (
          <ChatUnitView
            key={unit.key}
            unit={unit}
            streaming={streaming}
            showTrailingCards={showTrailingCards}
            ownedToolCalls={ownedToolCalls}
            isUser={isUser}
            {...(onAnswerQuestions ? { onAnswerQuestions } : {})}
          />
        ))}
        {message.plan && showTrailingCards ? (
          <PlanSummaryCard
            plan={message.plan.current.plan}
            {...(onOpenPlan ? { onOpen: onOpenPlan } : {})}
          />
        ) : null}
        {message.units.length === 0 && message.files.length === 0 && !streaming ? (
          <span className="text-xs text-muted-foreground">（空消息）</span>
        ) : null}
      </MessageContent>
      <MessageActions
        className={cn(
          '-mt-1 w-full opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
          isUser && 'justify-end',
        )}
      >
        <MessageCopyMenu message={message.source} />
      </MessageActions>
    </Message>
  )
})
