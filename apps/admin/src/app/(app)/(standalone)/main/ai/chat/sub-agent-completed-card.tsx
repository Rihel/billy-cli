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
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-sm">
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
            className="ml-auto h-auto shrink-0 px-0 text-xs"
            onClick={() => onOpen(data.subRunId)}
          >
            查看过程
          </Button>
        ) : data.childConversationId ? (
          <Link
            href={conversationPath(data.childConversationId)}
            className="ml-auto shrink-0 text-xs text-primary hover:underline"
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
