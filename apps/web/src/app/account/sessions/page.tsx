'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { parseUserAgent } from '@repo/shared'
import type { SessionEntryModel } from '@repo/shared'
import { ConfirmAction, Skeleton, Tag, cn, toastSuccess } from '@repo/ui'
import { MonitorSmartphoneIcon, SmartphoneIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'

const SESSIONS_QUERY_KEY = ['session', 'list'] as const

/** 时间展示：只到分钟（登录设备与最后活跃都不需要秒级精度） */
const formatDateTime = (value: number): string =>
  new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))

/**
 * 登录设备：列出当前账号的全部会话，可下线非本机会话。
 *
 * - 数据源：`client.session.list()`（服务端按请求 token 标出 `current`）；
 * - 下线后立即 `invalidateQueries` 刷新列表；被下线的设备在下一次请求时会拿到 401，
 *   由 `onUnauthorized` 清凭证并跳登录页（无需本页额外处理）；
 * - **本机不提供下线按钮**：要退出请用登出，避免用户把自己踢掉却以为是退出。
 */
export default function SessionsPage() {
  const client = useServerClient()
  const queryClient = useQueryClient()

  const sessions = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => client.session.list(),
  })

  const removeSession = useMutation({
    mutationFn: (sessionId: string) => client.session.remove({ sessionId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY })
      toastSuccess('该设备已下线，它的下次请求会被要求重新登录')
    },
  })

  const items = sessions.data?.items ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-tight">登录设备</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          这些设备正在使用你的账号。发现不认识的设备请立即下线，并修改密码。
        </p>
      </div>

      {sessions.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          暂无登录记录
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((session) => (
            <SessionCard
              key={session.sessionId}
              session={session}
              revoking={removeSession.isPending}
              onRevoke={() => removeSession.mutate(session.sessionId)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function SessionCard({
  session,
  revoking,
  onRevoke,
}: {
  session: SessionEntryModel
  revoking: boolean
  onRevoke: () => void
}) {
  const agent = parseUserAgent(session.userAgent)
  const Icon =
    agent.device === '移动' || agent.device === '平板' ? SmartphoneIcon : MonitorSmartphoneIcon

  return (
    <li
      className={cn(
        'flex items-start justify-between gap-4 rounded-xl border bg-card px-4 py-3.5',
        session.current ? 'border-brand/30 ring-1 ring-brand/20' : 'border-border',
      )}
    >
      <div className="flex min-w-0 gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4.5" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {agent.device} · {agent.browser}
            </span>
            {session.current ? <Tag color="processing">本机</Tag> : null}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {agent.os} · {session.ip ?? 'IP 未知'}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            登录于 {formatDateTime(session.createdAt)} · 最后活跃{' '}
            {formatDateTime(session.lastSeenAt)}
          </div>
        </div>
      </div>

      {session.current ? (
        <span className="pt-1 text-xs whitespace-nowrap text-muted-foreground">当前设备</span>
      ) : (
        <ConfirmAction
          danger
          disabled={revoking}
          title="下线该设备？"
          description="该设备将立即失去登录态，需要重新输入账号密码。"
          okText="确认下线"
          onConfirm={onRevoke}
        >
          下线
        </ConfirmAction>
      )}
    </li>
  )
}
