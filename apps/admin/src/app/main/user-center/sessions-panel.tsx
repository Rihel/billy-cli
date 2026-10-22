'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { parseUserAgent } from '@repo/shared'
import {
  ConfirmAction,
  Skeleton,
  Tag,
  toastSuccess,
} from '@repo/ui'
import { useServerClient } from '@/lib/server-client'

const SESSIONS_QUERY_KEY = ['session', 'list'] as const

/** 时间展示到分钟（登录设备不需要秒级精度） */
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
 * 个人中心的「登录设备」区块：列出当前管理员的会话，可下线非本机设备。
 * 与前台 `/account/sessions` 共用 `client.session.list()`（服务端按身份分域）。
 */
export function SessionsPanel() {
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
      toastSuccess('该设备已下线')
    },
  })

  const items = sessions.data?.items ?? []

  return (
    <section className="rounded-xl bg-surface-1 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-base font-medium tracking-tight">登录设备</h2>
        <span className="text-xs text-muted-foreground">
          共 {items.length} 台；下线后该设备需重新登录
        </span>
      </div>

      {sessions.isPending ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : items.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">暂无登录记录</p>
      ) : (
        <div className="mt-4">
          {items.map((session) => {
            const agent = parseUserAgent(session.userAgent)
            return (
              <div
                key={session.sessionId}
                className="flex items-center justify-between gap-4 rounded-lg px-2 py-3 even:bg-surface-2"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">{agent.device} · {agent.browser}</span>
                    {session.current ? <Tag color="blue">本机</Tag> : null}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {agent.os} · {session.ip ?? 'IP 未知'} · 登录于{' '}
                    {formatDateTime(session.createdAt)} · 最后活跃{' '}
                    {formatDateTime(session.lastSeenAt)}
                  </div>
                </div>

                {session.current ? (
                  <span className="shrink-0 text-xs text-muted-foreground">当前设备</span>
                ) : (
                  <ConfirmAction
                    danger
                    disabled={removeSession.isPending}
                    title="下线该设备？"
                    description="该设备将立即失去登录态，需要重新登录。"
                    okText="确认下线"
                    onConfirm={() => removeSession.mutate(session.sessionId)}
                  >
                    下线
                  </ConfirmAction>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
