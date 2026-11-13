'use client'

import { useState } from 'react'
import { Badge, Card, Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from '@repo/ui'
import { BotIcon, ChevronDownIcon, LoaderCircleIcon } from 'lucide-react'
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@repo/ui/components/ai-elements/message.tsx'
import { durationText, tokenText } from './format'
import { statusLabel, statusVariant } from './sub-agent-panel'
import {
  isSubAgentActive,
  subAgentBodyText,
  subAgentStatus,
  type SubAgentLive,
} from './sub-agent-live'

/**
 * 子助手在**主时间线**上的形态：一张紧凑卡，**可展开看正文**。
 *
 * 两条用户反馈决定了这个形态：
 * 1. "子 agent 的输出还是在主 timeline 显示" → 过程（推理 / 工具往返）挪进右栏，卡片只留结论；
 * 2. "看不到内容，展开不了" → 卡片**必须能点开**：展开后渲染子助手的正文（跑完是最终结论，
 *    运行中就是已经产出的那段，边跑边长），而不是只给一句"过程见右栏"。
 *
 * 默认**收起**（时间线要能一眼扫完"主 agent 走到哪了"）：标题行有 chevron 明确表示可展开，
 * 想看内容点一下即可；完整过程（含推理与每次工具往返）始终在右栏。
 *
 * 展开后的正文用与主对话同一个 `MessageResponse`（Markdown）—— 同一套渲染，不另写一份样式。
 */
export function SubAgentCard({ agent }: { agent: SubAgentLive }) {
  const [open, setOpen] = useState(false)
  const active = isSubAgentActive(agent)
  const status = subAgentStatus(agent)
  const totalTokens = agent.usage?.totalTokens
  // 耗时：服务端在子 run 的状态块里给了 `durationMs`（跑完那一条），与工具卡同一套显示口径
  const duration = typeof agent.durationMs === 'number' ? durationText(agent.durationMs) : null
  const body = subAgentBodyText(agent)

  return (
    <Card className="gap-0 py-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className={cn(
            'flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted/50',
          )}
          // 展开态要能读屏：把"这是可展开的子助手卡"说清楚，而不是让读屏只看到一串徽标
          aria-label={`子助手 ${agent.name} 的执行正文${open ? '（点击收起）' : '（点击展开）'}`}
        >
          {active ? (
            <LoaderCircleIcon
              className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
              aria-hidden
            />
          ) : (
            <BotIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate font-medium">子助手 · {agent.name}</span>
          <Badge variant={statusVariant(status)}>{statusLabel[status] ?? status}</Badge>
          <span className="w-full text-xs text-muted-foreground sm:w-auto">
            {agent.stepCount ?? 0} 步 / {agent.toolCallCount ?? 0} 次工具
            {/* 子助手自己的消耗（k / m 缩写，与右下角统计同一套口径）；
                它**已计入父那一轮的合计**（`rollUpUsage`），不是额外再花一份 */}
            {typeof totalTokens === 'number' ? ` · ${tokenText(totalTokens)} token` : ''}
            {duration ? ` · ${duration}` : ''}
          </span>
          <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground sm:inline">
            过程见右栏
          </span>
          <ChevronDownIcon
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </CollapsibleTrigger>

        <CollapsibleContent>
          {body ? (
            // 正文可能是整篇报告（几万字），给一个限高 + 内部滚动：不撑爆时间线，也读得完
            <div className="max-h-80 overflow-auto bg-surface-1 px-3 py-2">
              <Message from="assistant" className="max-w-full gap-0">
                <MessageContent className="gap-1">
                  <MessageResponse>{body}</MessageResponse>
                </MessageContent>
              </Message>
            </div>
          ) : (
            <p className="bg-surface-1 px-3 py-2 text-xs text-muted-foreground">
              {active
                ? '正在干活，还没有产出正文 —— 过程（推理与工具往返）在右栏。'
                : '这个子助手没有留下正文 —— 过程在右栏。'}
            </p>
          )}
          {agent.error ? (
            <p className="bg-destructive/10 px-3 py-2 text-xs text-destructive">{agent.error}</p>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
