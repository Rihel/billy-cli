'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Button, RefreshButton, cn } from '@repo/ui'
import { PlusIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import { conversationPath, newConversationPath, CHAT_ROOT } from './routes'

/**
 * 会话页的**外层壳**：左侧会话列表（库里的真相）。
 *
 * 为什么做成路由的 `layout`（而不是页面里的一个 `<aside>`）：
 * 会话列表**不随会话切换重挂载** —— 切换会话只换右侧内容，
 * 列表的滚动位置、TanStack Query 的缓存、刷新按钮的状态都保持原样；
 * 同时"每个会话一个地址"由 `<Link href>` 表达（可新开标签、可前进后退）。
 *
 * 列表的真相来自 `POST /agent/conversation/list`；页面在首轮问答后
 * `invalidateQueries(['ai','conversations'])` 刷新它（同一个 QueryClient，不需要 prop 传递）。
 */
export default function ChatLayout({ children }: { children: ReactNode }) {
  const client = useServerClient()
  const pathname = usePathname()
  const conversationsQuery = useQuery({
    queryKey: ['ai', 'conversations'],
    queryFn: () =>
      client.agent.conversation.list({ page: 1, size: 20, includeDeleted: false }),
  })

  const items = conversationsQuery.data?.items ?? []
  const isNewRoute = pathname === newConversationPath()
  const isRoot = pathname === CHAT_ROOT

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl gap-4 p-4">
      <aside className="hidden w-64 shrink-0 flex-col gap-2 md:flex">
        <div className="flex items-center gap-2">
          {/* 新建 = 跳到 `new` 这个保留段：首轮发出后服务端给会话 id，页面再 replace 成真实地址 */}
          <Button
            size="sm"
            className="gap-1.5"
            render={
              <Link href={newConversationPath()}>
                <PlusIcon className="size-3.5" />
                新建会话
              </Link>
            }
          />
          <RefreshButton onClick={() => void conversationsQuery.refetch()} />
        </div>
        <div className="flex-1 overflow-auto rounded-lg border border-border">
          {items.map((conversation) => {
            const active = pathname === conversationPath(conversation.id)
            return (
              <Link
                key={conversation.id}
                href={conversationPath(conversation.id)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex w-full flex-col gap-1 border-b border-border px-3 py-2 text-left text-sm last:border-b-0',
                  'transition-colors hover:bg-muted/50',
                  active && 'bg-muted',
                )}
              >
                <span className="truncate font-medium">{conversation.title || '(无标题)'}</span>
                {/* 只显示"几轮"：**不在这里显示 token** ——
                    消耗数字统一在对话框右下角（本轮 `data-run-usage`），
                    列表里再放一个"跨轮累计"会让同一个词（token）指两个不同的东西。
                    累计值在库里（`conversations.total_tokens`），将来要展示就放会话详情，不塞列表行。 */}
                <span className="text-xs text-muted-foreground">{conversation.turnCount} 轮</span>
              </Link>
            )
          })}
          {items.length === 0 && !conversationsQuery.isLoading && (
            <p className="p-3 text-xs text-muted-foreground">还没有会话</p>
          )}
          {conversationsQuery.isLoading && (
            <p className="p-3 text-xs text-muted-foreground">正在加载会话…</p>
          )}
        </div>
        {isNewRoute || isRoot ? (
          <p className="px-1 text-xs text-muted-foreground">新会话：发出第一条消息后自动建立</p>
        ) : null}
      </aside>

      {/* 右：对话区（由具体路由渲染：新会话 / 某个会话） */}
      <section className="flex min-w-0 flex-1 flex-col gap-3">{children}</section>
    </div>
  )
}
