'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Card,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
} from '@repo/ui'
import { ArrowUpRightIcon, BotIcon, ChevronDownIcon, LoaderCircleIcon } from 'lucide-react'
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@repo/ui/components/ai-elements/message.tsx'
import { durationText, tokenText } from './format'
import { conversationPath } from './routes'
import { statusLabel, statusVariant } from './sub-agent-panel'
import {
  isSubAgentActive,
  liveToolCallCount,
  subAgentBodyText,
  subAgentStatus,
  type SubAgentLive,
} from './sub-agent-live'

/**
 * 子助手在**主时间线**上的形态：一张紧凑卡，**可展开看正文**。
 *
 * 三条用户反馈决定了这个形态：
 * 1. "子 agent 的输出还是在主 timeline 显示" → 完整过程（推理 / 工具往返）挪出主时间线，
 *    卡片只留结论；
 * 2. "看不到内容，展开不了" → 卡片**必须能点开**：展开后渲染子助手的正文（跑完是最终结论，
 *    运行中就是已经产出的那段，边跑边长），而不是只给一句"过程见别处"；
 * 3. 完整过程现在是主区**顶部的子 agent tab**（跟主会话平级的另一条会话，见 `session-tabs.tsx`），
 *    卡片上的入口就是"切过去"那一步 —— 不跳路由、不打断当前页面。
 *
 * 默认**收起**（时间线要能一眼扫完"主 agent 走到哪了"）：标题行有 chevron 明确表示可展开，
 * 想看内容点一下即可。
 *
 * 展开后的正文用与主对话同一个 `MessageResponse`（Markdown）—— 同一套渲染，不另写一份样式。
 */
export function SubAgentCard({
  agent,
  onOpen,
}: {
  agent: SubAgentLive
  /**
   * 「查看过程」：切到该子 agent 的 tab。
   *
   * 不传时退回跳子会话路由：子 agent 自己再委派时，孙 run 不在本层 tab 列表里，
   * 那种嵌套场景走子会话地址更诚实。两者都没有就只留一句说明。
   */
  onOpen?: (runId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const active = isSubAgentActive(agent)
  const status = subAgentStatus(agent)
  const totalTokens = agent.usage?.totalTokens
  // 耗时：服务端在子 run 的状态块里给了 `durationMs`（跑完那一条），与工具卡同一套显示口径。
  // 起跑快照里是 `0`（不是耗时），0 不显示 —— 否则运行中的卡片会挂一个"0ms"。
  const duration =
    typeof agent.durationMs === 'number' && agent.durationMs > 0
      ? durationText(agent.durationMs)
      : null
  /**
   * 工具次数：终态用库里的 `toolCallCount`（权威）；运行中它还是 0，改数实时事件里的调用次数。
   * 步数只有收尾才落库，所以**运行中不显示"N 步"**（显示 0 会谎报"一步没走"）。
   */
  const toolCalls = Math.max(agent.toolCallCount ?? 0, liveToolCallCount(agent))
  const stepCount = agent.stepCount ?? 0
  const progress = active ? `已调用 ${toolCalls} 次工具` : `${stepCount} 步 / ${toolCalls} 次工具`
  const body = subAgentBodyText(agent)

  /**
   * 入口**必须放在 trigger 外面**：trigger 本身是个 `<button>`，按钮里再嵌链接 / 按钮
   * 是无效嵌套（键盘与读屏都会乱），只在它外面挂一个入口就干净了。
   */
  const entry = onOpen ? (
    <Button
      variant="link"
      size="sm"
      // 手机上加一节纵向内边距把「查看过程」抬到 ~28px 高（纯文字行高只有 ~16px，拇指很难点中）；
      // lg 起 py-0 还原成与改动前完全一致的链接样式。
      className="h-auto shrink-0 px-0 py-1.5 text-xs lg:py-0"
      onClick={() => onOpen(agent.runId)}
    >
      查看过程
    </Button>
  ) : agent.conversationId ? (
    <Link
      href={conversationPath(agent.conversationId)}
      // 同 entry：窄屏给可点高度，桌面不加任何内边距
      className="shrink-0 py-1.5 text-xs text-primary hover:underline lg:py-0"
    >
      打开子会话
      <ArrowUpRightIcon className="ml-0.5 inline size-3" aria-hidden />
    </Link>
  ) : (
    <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">暂无独立会话</span>
  )

  return (
    /*
      卡片必须**自己成面**：会话区现在是白纸，`Card` 默认又是纯白无边框，
      白卡贴白纸等于没有卡（2026-11-21 反馈）。与工具卡同一套：白卡 + 发丝边 +
      `surface-2` 的标题栏（收起时整张就是那条标题栏），展开后正文落回白底。
    */
    <Card className="gap-0 overflow-hidden rounded-lg border border-border/60 bg-card py-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        {/* 标题栏的底色挂在**整行**上：右侧「查看过程」在 trigger 外面，底色只给 trigger 会留一截白 */}
        <div className="flex items-center gap-2 bg-surface-2 pr-4">
          <CollapsibleTrigger
            className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-left text-sm transition-colors hover:bg-surface-3/70"
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
            <span className="min-w-0 max-w-[45%] shrink truncate font-medium">
              子助手 · {agent.name}
            </span>
            {/* 状态与消耗紧贴标题右侧（不再被 flex-1 推到最右），中间留白交给后面的 spacer */}
            <Badge variant={statusVariant(status)}>{statusLabel[status] ?? status}</Badge>
            {/*
              桌面一行放得下：进度跟在徽标后面，超长时 truncate 省略；
              手机一行只剩 ~20px，会被截成「已…」，等于把步数 / token / 耗时全丢掉 ——
              窄屏让它独占第二行（order-last + basis-full），lg 起 order/basis 还原，
              视觉上仍是徽标右边的同一行。
            */}
            <span className="order-last min-w-0 basis-full truncate text-xs text-muted-foreground lg:order-none lg:basis-auto">
              {progress}
              {/* 子助手自己的消耗（k / m 缩写，与右下角统计同一套口径）；
                  它**已计入父那一轮的合计**（`rollUpUsage`），不是额外再花一份 */}
              {typeof totalTokens === 'number' ? ` · ${tokenText(totalTokens)} token` : ''}
              {duration ? ` · ${duration}` : ''}
            </span>
            <span className="flex-1" aria-hidden />
            <ChevronDownIcon
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-180',
              )}
              aria-hidden
            />
          </CollapsibleTrigger>
          {entry}
        </div>

        <CollapsibleContent>
          {body ? (
            // 正文可能是整篇报告（几万字），给一个限高 + 内部滚动：不撑爆时间线，也读得完
            <div className="max-h-80 overflow-auto px-4 py-2">
              <Message from="assistant" className="max-w-full gap-0">
                <MessageContent className="gap-1">
                  <MessageResponse>{body}</MessageResponse>
                </MessageContent>
              </Message>
            </div>
          ) : (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              {active
                ? '正在干活，还没有产出正文 —— 点右上角入口看完整过程。'
                : '这个子助手没有留下正文 —— 点右上角入口看完整过程。'}
            </p>
          )}
          {agent.error ? (
            <p className="bg-destructive/10 px-4 py-2 text-xs text-destructive">{agent.error}</p>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
