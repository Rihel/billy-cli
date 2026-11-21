'use client'

import Link from 'next/link'
import { Badge, Button, Card } from '@repo/ui'
import { ArrowUpRightIcon, BotIcon } from 'lucide-react'
import { conversationPath } from './routes'
import type { SubAgentCompletedData } from './chat-session'

/**
 * 「子 agent 完成」系统卡（父会话时间线里）。
 *
 * 它回答的是"这一轮不是我发的，为什么它自己开始了"：子助手交回结论后触发了父的新一轮。
 * 形态刻意**比子助手卡更轻**（一行）：结论全文在子会话里，这里只给摘要 + 打开入口。
 */
export function SubAgentCompletedCard({
  data,
  onOpen,
}: {
  data: SubAgentCompletedData
  /**
   * 「查看过程」：切到主区顶部该子助手的 tab。
   *
   * 父会话里**一律传**（点击卡片就切 tab，不跳子会话路由 —— 跳过去会进那条只读子会话，
   * 上方 tab 只剩「主会话」一个，看起来像"tab 变少了"）；只有拿不到 tab 的场景（子会话里
   * 再嵌套委派）才退回跳路由。
   */
  onOpen?: (runId: string) => void
}) {
  const succeeded = data.childStatus === 'succeeded'
  const summary = [data.summary, data.error].filter(Boolean).join(' ').trim()
  return (
    /*
      单行系统卡：收起态的子助手卡就是一条 `surface-2` 标题栏，这张卡与它同形 ——
      白底上给一条有边界的灰带，才看得出"这是主时间线之外插进来的一条系统事件"。
    */
    <Card className="gap-0 rounded-lg border border-border/60 bg-surface-2 py-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-sm">
        <BotIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-medium">
          子助手「{data.name}」已完成，父会话继续
        </span>
        <Badge variant={succeeded ? 'secondary' : 'destructive'}>
          {succeeded ? '已完成' : '失败'}
        </Badge>
        {onOpen ? (
          <Button
            variant="link"
            size="sm"
            // 手机把「查看过程」抬到 ~28px 高再给拇指点；lg 起 py-0 与改动前一致
            className="ml-auto h-auto shrink-0 px-0 py-1.5 text-xs lg:py-0"
            onClick={() => onOpen(data.subRunId)}
          >
            查看过程
          </Button>
        ) : data.childConversationId ? (
          <Link
            href={conversationPath(data.childConversationId)}
            className="ml-auto shrink-0 py-1.5 text-xs text-primary hover:underline lg:py-0"
          >
            打开子会话
            <ArrowUpRightIcon className="ml-0.5 inline size-3" aria-hidden />
          </Link>
        ) : null}
        {summary ? (
          <p className="w-full whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
            {summary}
          </p>
        ) : null}
      </div>
    </Card>
  )
}
