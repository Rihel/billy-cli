'use client'

import {
  getToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from 'ai'
import { Badge } from '@repo/ui'
// ai-elements 组件**走子路径**（不进 barrel：体积大、按需引入，见 docs/design/ai-agent.md §1）
import { Message, MessageContent, MessageResponse } from '@repo/ui/components/ai-elements/message.tsx'
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@repo/ui/components/ai-elements/reasoning.tsx'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@repo/ui/components/ai-elements/tool.tsx'
import { useServerClient } from '@/lib/server-client'
import { PlanPanel, collectMessagePlan, isPlanToolName } from './plan-panel'
import { SubAgentPanel, type SubAgentDelta, type SubAgentState } from './sub-agent-panel'
import { toSubAgentDetail } from './history'
import { loadWholeTimeline } from './data'

/**
 * 一条消息：把 parts 铺成"看得见的细节"。
 *
 * 顺序即 parts 顺序（服务端就是这么流出来的），每类 part 用对应的 AI Elements 组件：
 * 文本 → `MessageResponse`（流式 Markdown）、推理 → `Reasoning`、
 * 工具 → `Tool*`（七态徽标 + 入参出参）、子助手 → `SubAgentPanel`（嵌套卡片）、
 * 计划 → `PlanPanel`（**一条消息只渲染一次当前计划**，放在 parts 末尾）。
 */
export function MessageRow({
  message,
  streaming,
  client,
  conversationId,
}: {
  message: UIMessage
  streaming: boolean
  client: ReturnType<typeof useServerClient>
  conversationId?: string
}) {
  const isUser = message.role === 'user'

  /**
   * 计划：两条链路在这里合流 ——
   * - 实时：最后一个 `plan-*` 工具调用的出参；
   * - 历史：`history.ts` 合成的 `data-plan` part（按 revision 取最新版）。
   * 被卡片吸收的 part 下标进 `consumed`，渲染时跳过原始工具卡（否则同一次调用会出两张卡）。
   */
  const messagePlan = collectMessagePlan(message.parts)

  // 子助手：状态块按 id 归并，增量块按顺序累计（两类块在服务端就是分开写的）
  const subAgents = new Map<string, SubAgentState>()
  const subAgentDeltas = new Map<string, SubAgentDelta[]>()
  for (const part of message.parts) {
    if (part.type === 'data-sub-agent') {
      const data = part.data as Record<string, unknown>
      const runId = String(data.runId ?? part.id ?? '')
      subAgents.set(runId, { ...(data as object), runId } as SubAgentState)
    } else if (part.type === 'data-sub-agent-delta') {
      const data = part.data as { runId?: string; kind?: 'text' | 'reasoning'; text?: string }
      const runId = String(data.runId ?? '')
      const list = subAgentDeltas.get(runId) ?? []
      list.push({ kind: data.kind ?? 'text', text: data.text ?? '' })
      subAgentDeltas.set(runId, list)
    }
  }
  // 历史模式下前端只有结论：给面板一个"按需拉子 run 时间线"的回调
  for (const [runId, state] of subAgents) {
    // 只有"已经有结论"的子助手才值得去拉明细（进行中的正在流，别重复请求）
    if (conversationId && state.status && state.status !== 'running') {
      state.loadDetail = async () =>
        toSubAgentDetail(await loadWholeTimeline(client, conversationId, runId))
    }
  }

  return (
    <Message from={message.role}>
      <MessageContent>
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
            return (
              <Reasoning key={index} isStreaming={streaming && part.state === 'streaming'}>
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            )
          }
          if (isToolUIPart(part)) {
            // 计划工具：出参已由 PlanPanel 呈现（含中间版本），不再铺一张原始工具卡；
            // 认不出的出参不在 consumed 里，这里照旧显示原文（"看不懂的东西也要看得见"）
            if (messagePlan?.consumed.includes(index)) return null
            const toolName = getToolName(part)
            return (
              <Tool key={index} defaultOpen={isPlanToolName(toolName)}>
                <ToolHeader type="dynamic-tool" state={part.state} toolName={toolName} />
                <ToolContent>
                  <ToolInput input={part.input} />
                  {part.state === 'output-available' && (
                    <ToolOutput output={part.output} errorText={undefined} />
                  )}
                  {part.state === 'output-error' && (
                    <ToolOutput output={undefined} errorText={part.errorText} />
                  )}
                </ToolContent>
              </Tool>
            )
          }
          if (part.type === 'data-plan') {
            // 历史里的计划事件：已由末尾的 PlanPanel 代表；解析不出的才露个标记（协议漂移可见）
            if (messagePlan?.consumed.includes(index)) return null
            return (
              <span key={index} className="text-xs text-muted-foreground">
                <Badge variant="outline">data-plan</Badge>
              </span>
            )
          }
          if (part.type === 'data-sub-agent') {
            const data = part.data as Record<string, unknown>
            const runId = String(data.runId ?? part.id ?? '')
            const state = subAgents.get(runId)
            if (!state) return null
            return (
              <SubAgentPanel
                key={`${runId}-${index}`}
                agent={state}
                deltas={subAgentDeltas.get(runId) ?? []}
              />
            )
          }
          if (part.type === 'data-sub-agent-delta') {
            // 增量块本身不渲染（已并入上面的面板），避免重复显示
            return null
          }
          if (part.type === 'data-run') {
            return null
          }
          if (part.type === 'data-run-usage') {
            // 用量统一在输入框右下角渲染（RunUsageInline），消息里不再重复
            return null
          }
          // 未知 part 类型显式露出来：协议演进时"看得见"比"静默丢掉"好排障
          return (
            <span key={index} className="text-xs text-muted-foreground">
              <Badge variant="outline">{part.type}</Badge>
            </span>
          )
        })}
        {/* 当前计划固定在消息末尾：一个消息里只渲染一次（更早的版本折在卡片的「变更历史」里） */}
        {messagePlan ? (
          <PlanPanel
            plan={messagePlan.current.plan}
            change={messagePlan.current.change}
            history={messagePlan.history}
          />
        ) : null}
        {message.parts.length === 0 ? (
          <span className="text-xs text-muted-foreground">（空消息）</span>
        ) : null}
      </MessageContent>
    </Message>
  )
}
