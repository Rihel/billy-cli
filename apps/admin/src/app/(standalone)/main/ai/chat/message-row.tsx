'use client'

import {
  getToolName,
  isFileUIPart,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from 'ai'
import { TOOL_EVENT_PART_TYPE } from '@repo/shared'
import { Badge, PromptAttachments, cn, useStorageAdapter } from '@repo/ui'
import type { PromptAttachmentItem } from '@repo/ui'
// ai-elements 组件**走子路径**（不进 barrel：体积大、按需引入，见 docs/design/ai-agent.md §1）
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
import { collectMessagePlan, isPlanToolName } from './plan-panel'
import { PlanSummaryCard } from './plan-summary-card'
import { SubAgentCard } from './sub-agent-card'
import { collectSubAgentLives, delegatedToolCallIds } from './sub-agent-live'
import { ToolCard } from './tool-card'
import { ToolEventCard, ToolEventsBody, groupToolEventsByToolCall } from './tool-event'
import { QuestionCard, type AnswerQuestionsInput, type SuspendedPartData } from './question-card'
import { MessageCopyMenu } from './message-copy'

/**
 * 一条消息：把 parts 铺成"看得见的细节"。
 *
 * 顺序即 parts 顺序（服务端就是这么流出来的），每类 part 用对应的 AI Elements 组件：
 * 文本 → `MessageResponse`（流式 Markdown）、推理 → `Reasoning`、
 * 工具 → `ToolCard`（七态徽标 + 入参出参 + 自定义事件，卡内形态归 `tool-card.tsx`）、
 * 子助手 → `SubAgentCard`（**只留结论与状态的紧凑卡**，过程在右栏）、
 * 计划 → `PlanSummaryCard`（**一句目标 + 进度 + "查看清单"入口**，完整清单在右栏「任务」tab）。
 *
 * 工具自定义事件（`data-tool-event`）**先扫一遍分桶**：能按 `toolCallId` 对上工具卡的并进那张卡，
 * 对不上的（子 agent 内部工具发的）独立成 `ToolEventCard` —— 事件是过程，不许静默丢。
 *
 * 消息末尾挂一条**操作行**（目前只有"复制"）：悬停 / 键盘聚焦时才显形 ——
 * 每条消息底下常驻一排按钮会把对话切得七零八落。
 */
/**
 * part 上带的**历史耗时**（毫秒）：历史合成时从时间线（审计的 `outcome.durationMs` /
 * 行自己的 `durationMs`）读出来挂在 part 上的。
 *
 * 实时那条流里没有这个字段 —— 那种情况由工具卡自己从"挂载 → 结束"现算（见 `tool-card.tsx`）。
 */
const partDurationMs = (part: unknown): number | undefined => {
  const value = (part as { durationMs?: unknown }).durationMs
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 附件 part 上带的**存储 key 与字节数**。
 *
 * AI SDK 的 `FileUIPart` 类型里没有这两个字段，但它们是**我们自己的历史重建**（`history.ts`
 * 从时间线 payload 合成）挂上去的 —— 回看时要显示大小、要能按 key 去签下载地址。
 * 读不出来就是 undefined（实时那条流里确实没有），不编造。
 */
const attachmentKeyOf = (part: unknown): string | undefined => {
  const value = (part as { attachmentKey?: unknown }).attachmentKey
  return typeof value === 'string' && value ? value : undefined
}

const attachmentBytesOf = (part: unknown): number | undefined => {
  const value = (part as { attachmentBytes?: unknown }).attachmentBytes
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function MessageRow({
  message,
  streaming,
  onOpenPlan,
  onPreviewImage,
  onAnswerQuestions,
  showTrailingCards = true,
}: {
  message: UIMessage
  streaming: boolean
  /** 点"查看清单"：会话页负责把右栏切到「任务」tab（不传则只展示） */
  onOpenPlan?: () => void
  /** 点附件里的图片：会话页打开大图查看器（与输入框待发附件共用同一套交互） */
  onPreviewImage?: (items: readonly PromptAttachmentItem[], index: number) => void
  /** 回答工具挂起的问题：会话页负责 POST resume 并把续跑的流并回当前消息 */
  onAnswerQuestions?: (input: AnswerQuestionsInput) => Promise<void>
  /**
   * 是否渲染"计划卡 / 问题卡"这类悬浮卡。
   *
   * 会话主区把它关掉：待回答的问题卡固定在输入框上方（`ChatConversation` 的 dock），
   * 计划卡也固定在输入框上方；**已回答的问题卡不受这个开关影响**，永远留在
   * 时间线的原位置当问答记录。右栏的历史预览保留默认的 true。
   */
  showTrailingCards?: boolean
}) {
  const isUser = message.role === 'user'
  /** 历史里的附件只有存储 key：用应用注入的规则拼成可访问地址（实时那条消息自带地址） */
  const { resolveUrl } = useStorageAdapter()

  /**
   * 计划：两条链路在这里合流 ——
   * - 实时：最后一个 `plan-*` 工具调用的出参；
   * - 历史：`history.ts` 合成的 `data-plan` part（按 revision 取最新版）。
   * 被卡片吸收的 part 下标进 `consumed`，渲染时跳过原始工具卡（否则同一次调用会出两张卡）。
   */
  const messagePlan = collectMessagePlan(message.parts)

  // 工具自定义事件：与计划一样先扫一遍 parts（事件可能出现在工具卡前后，渲染时才分桶会漏），
  // 且**不自己去重** —— `state` 的 id 归并是 AI SDK 按 `message.parts` 做的，前端只管顺序渲染
  const toolEvents = groupToolEventsByToolCall(message.parts)

  // 子助手：状态块按 id 归并、增量块按顺序累计（两类块在服务端就是分开写的）。
  // 收集口径与右栏的实时明细共用一处（`sub-agent-live.ts`）—— 主时间线只拿结论与状态。
  const subAgentLives = collectSubAgentLives(message.parts)
  const subAgentById = new Map(subAgentLives.map((live) => [live.runId, live]))
  /** 被委派的 `run-sub-agent` 调用 id：子助手卡已代表它们（见 `delegatedToolCallIds` 的说明） */
  const delegatedToolCalls = delegatedToolCallIds(subAgentLives)

  /**
   * 附件（用户消息的 file part）：**合并成一条附件行**渲染，不逐 part 铺。
   *
   * 为什么不逐个 part 渲染：一条消息里连粘三张图会出三行、行与行之间还被消息的 `gap-1.5` 撑着，
   * 看着像三条独立消息。附件行本身由 `@repo/ui` 的 `PromptAttachments` 出（与输入框上方那条
   * 待发附件**同一个外观**，用户对"我发出去的东西"和"我正要发的东西"看到的是同一种卡）。
   */
  const fileParts = message.parts.filter(isFileUIPart)
  const firstFilePartIndex = message.parts.findIndex(isFileUIPart)
  const attachmentItems: PromptAttachmentItem[] = fileParts.map((part, index) => {
    const storageKey = attachmentKeyOf(part)
    /**
     * 预览地址从哪来（两条链路各有一份）：
     * - 历史（从时间线重建）：只有存储 key → 用应用注入的 `resolveUrl` 拼；
     * - 实时（刚发出去那条）：part 自带 `url`（本地 blob 或 data URL）→ 直接可用，
     *   而且不必等对象存储。
     */
    const previewUrl = part.url || (storageKey ? resolveUrl(storageKey) : '')
    return {
      key: storageKey ?? `${message.id}-file-${index}`,
      filename: part.filename ?? '未命名文件',
      mediaType: part.mediaType ?? '',
      ...(attachmentBytesOf(part) !== undefined ? { bytes: attachmentBytesOf(part) } : {}),
      ...(previewUrl ? { previewUrl } : {}),
    }
  })

  return (
    // `max-w-full` 覆盖 ai-elements 默认的 `max-w-[95%]`：助手侧的工具卡要**铺满**整行
    // （左边"跑了什么"、右边"跑到哪了"），留 5% 的缝只会让工具条看着没对齐
    <Message from={message.role} className="max-w-full gap-1.5">
      <MessageContent
        className={cn(
          'gap-1.5 group-[.is-user]:px-3 group-[.is-user]:py-2',
          // 助手侧的内容默认铺满消息宽度：工具条 / 子助手卡 / 事件条都是"整行的条"，
          // 默认的 `w-fit` 会让只有一次工具调用、文字又短的那条缩成半截。
          // 用户气泡仍保持 `w-fit`（贴着内容收紧，不撑成整行）。
          !isUser && 'w-full',
        )}
      >
        {message.parts.map((part, index) => {
          if (isFileUIPart(part)) {
            // 附件行只在**第一个** file part 的位置铺一次（其余位置留空，别重复）
            if (index !== firstFilePartIndex) return null
            return (
              <PromptAttachments
                key={`files-${index}`}
                items={attachmentItems}
                {...(onPreviewImage ? { onPreviewImage } : {})}
              />
            )
          }
          if (isTextUIPart(part)) {
            return isUser ? (
              <p key={index} className="whitespace-pre-wrap">
                {part.text}
              </p>
            ) : (
              <MessageResponse key={index}>{part.text}</MessageResponse>
            )
          }
          if (isReasoningUIPart(part)) {
            // 思考时长：历史回放用时间线里记的毫秒数（没有就不传 —— 组件显示"思考完成"，
            // 不编造"几秒"）；实时那条由组件自己从流开始计时
            const reasoningMs = partDurationMs(part)
            return (
              <Reasoning
                key={index}
                isStreaming={streaming && part.state === 'streaming'}
                {...(reasoningMs !== undefined ? { duration: Math.max(1, Math.round(reasoningMs / 1000)) } : {})}
              >
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            )
          }
          if (isToolUIPart(part)) {
            // 这次工具调用发的事件：并进卡片正文（空数组时 `ToolEventsBody` 自己返回 null）
            const events = toolEvents.byToolCallId.get(part.toolCallId) ?? []
            // 委派类：子助手紧凑卡已代表这次调用（名字 / 状态 / 结论 / 指路右栏），不再铺原始工具卡
            if (delegatedToolCalls.has(part.toolCallId)) {
              return events.length > 0 ? (
                <ToolEventsBody key={index} toolKey={getToolName(part)} parts={events} />
              ) : null
            }
            const toolName = getToolName(part)
            // 问题工具由挂起卡片代表；只有真的报错时才露出原始工具卡
            if (toolName === 'ask-user-questions' && part.state !== 'output-error') return null
            // 计划工具：出参已由消息末尾的 PlanSummaryCard 代表（完整清单在右栏），不再铺原始工具卡；
            // 认不出的出参不在 consumed 里，这里照旧显示原文（"看不懂的东西也要看得见"）
            if (messagePlan?.consumed.includes(index)) {
              // 工具卡被计划卡片吸收了，但它发出的事件是**过程**，不能跟着一起消失
              return events.length > 0 ? (
                <ToolEventsBody key={index} toolKey={toolName} parts={events} />
              ) : null
            }
            return (
              <ToolCard
                key={index}
                part={part}
                events={events}
                defaultOpen={isPlanToolName(toolName)}
                streaming={streaming}
                {...(partDurationMs(part) !== undefined ? { durationMs: partDurationMs(part) } : {})}
              />
            )
          }
          if (part.type === 'data-plan') {
            // 历史里的计划事件：已由末尾的 PlanSummaryCard 代表；解析不出的才露个标记（协议漂移可见）
            if (messagePlan?.consumed.includes(index)) return null
            return (
              <span key={index} className="text-xs text-muted-foreground">
                <Badge variant="outline">data-plan</Badge>
              </span>
            )
          }
          if (part.type === TOOL_EVENT_PART_TYPE) {
            const event = toolEvents.byIndex.get(index)
            if (event) {
              // 已并进工具卡的不再重复渲染；没有卡可归属的（子 agent 内部工具发的 / 非流式调用）
              // 独立成卡 —— 事件是过程，宁可多一张卡也别让它消失
              const toolCallId = event.data.toolCallId
              if (toolCallId && toolEvents.byToolCallId.has(toolCallId)) return null
              return <ToolEventCard key={index} part={event} />
            }
            // 解析不出的同类 part 掉到末尾的"未知 part"分支：协议漂移要看得到
          }
          if (part.type === 'data-sub-agent') {
            const data = part.data as Record<string, unknown>
            const runId = String(data.runId ?? part.id ?? '')
            const live = subAgentById.get(runId)
            if (!live) return null
            return <SubAgentCard key={`${runId}-${index}`} agent={live} />
          }
          if (part.type === 'data-sub-agent-delta') {
            // 增量块本身不渲染（已并入子助手卡片 / 右栏），避免重复显示
            return null
          }
          if (part.type === 'data-tool-call-suspended') {
            const data = (part as { data?: SuspendedPartData }).data
            if (!data) return null
            // 待回答：主区把这组卡放在输入框上方（dock），消息流里不再重复；
            // 已回答：**留在原位置**当只读的问答记录 —— 否则刷新后整组问答在时间线上消失。
            if (data.resumed !== true) {
              if (!showTrailingCards) return null
              return (
                <QuestionCard
                  key={index}
                  data={data}
                  {...(onAnswerQuestions ? { onSubmit: onAnswerQuestions } : {})}
                />
              )
            }
            return <QuestionCard key={index} data={data} />
          }
          if (part.type === 'step-start') {
            // **步骤边界是协议管道**（AI SDK 每进一个 agent step 就往 parts 里 push 一个 `step-start`）：
            // 界面上「Thought for N seconds」+ 工具卡已经把"这一步干了什么"表达完了，
            // 再挂一个 step-start 徽标纯属噪音（用户看到的就是这个）
            return null
          }
          if (part.type === 'data-run' || part.type === 'data-run-suspended') {
            return null
          }
          if (part.type === 'data-run-usage') {
            // 用量统一在输入框右下角渲染（RunUsageInline），消息里不再重复
            return null
          }
          if (part.type === 'data-conversation-title') {
            // 自动命名改的是**会话名**（侧栏 + 页头），与消息内容无关：
            // 这里显式吃掉，别让它掉进"未知 part"分支渲染成一个徽标
            return null
          }
          // 未知 part 类型显式露出来：协议演进时"看得见"比"静默丢掉"好排障
          return (
            <span key={index} className="text-xs text-muted-foreground">
              <Badge variant="outline">{part.type}</Badge>
            </span>
          )
        })}
        {/* 当前计划固定在消息末尾：一个消息里只渲染一次。
            这里只给"有没有计划、做到哪了"这一眼 —— 完整清单（含备注与变更历史）在右栏「任务」tab，
            点卡片上的「查看清单」跳过去（消息里铺整份清单会把对话切成两半，且它随每轮变长） */}
        {messagePlan && showTrailingCards ? (
          <PlanSummaryCard plan={messagePlan.current.plan} onOpen={onOpenPlan} />
        ) : null}
        {/* 空消息占位只在"库里确实是空的"历史消息上出现：流刚建立时 parts 也是空的，
            那几百毫秒里闪一个「（空消息）」纯属噪声（streaming 时不显示） */}
        {message.parts.length === 0 && !streaming ? (
          <span className="text-xs text-muted-foreground">（空消息）</span>
        ) : null}
      </MessageContent>
      {/* 操作行：用户消息靠右（贴在气泡同侧），助手消息靠左 */}
      <MessageActions
        className={cn(
          'w-full -mt-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
          isUser && 'justify-end',
        )}
      >
        <MessageCopyMenu message={message} />
      </MessageActions>
    </Message>
  )
}
