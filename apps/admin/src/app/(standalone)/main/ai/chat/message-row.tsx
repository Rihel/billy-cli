'use client'

import {
  getToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from 'ai'
import { TOOL_EVENT_PART_TYPE } from '@repo/shared'
import { Badge, cn } from '@repo/ui'
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

export function MessageRow({
  message,
  streaming,
  onOpenPlan,
}: {
  message: UIMessage
  streaming: boolean
  /** 点"查看清单"：会话页负责把右栏切到「任务」tab（不传则只展示） */
  onOpenPlan?: () => void
}) {
  const isUser = message.role === 'user'

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

  return (
    // `max-w-full` 覆盖 ai-elements 默认的 `max-w-[95%]`：助手侧的工具卡要**铺满**整行
    // （左边"跑了什么"、右边"跑到哪了"），留 5% 的缝只会让工具条看着没对齐
    <Message from={message.role} className="max-w-full gap-1.5">
      <MessageContent className="gap-1.5 group-[.is-user]:px-3 group-[.is-user]:py-2">
        {message.parts.map((part, index) => {
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
            // 计划工具：出参已由消息末尾的 PlanSummaryCard 代表（完整清单在右栏），不再铺原始工具卡；
            // 认不出的出参不在 consumed 里，这里照旧显示原文（"看不懂的东西也要看得见"）
            if (messagePlan?.consumed.includes(index)) {
              // 工具卡被计划卡片吸收了，但它发出的事件是**过程**，不能跟着一起消失
              return events.length > 0 ? (
                <ToolEventsBody key={index} toolKey={getToolName(part)} parts={events} />
              ) : null
            }
            const toolName = getToolName(part)
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
          if (part.type === 'step-start') {
            // **步骤边界是协议管道**（AI SDK 每进一个 agent step 就往 parts 里 push 一个 `step-start`）：
            // 界面上「Thought for N seconds」+ 工具卡已经把"这一步干了什么"表达完了，
            // 再挂一个 step-start 徽标纯属噪音（用户看到的就是这个）
            return null
          }
          if (part.type === 'data-run') {
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
        {messagePlan ? (
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
