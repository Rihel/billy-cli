'use client'

import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import dayjs from 'dayjs'
import {
  AlertFiredEventSchema,
  STREAM_ALERT_FIRED_EVENT,
  type AlertFiredEventModel,
} from '@repo/shared'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageToolbar,
  Tag,
  cn,
  toastSuccess,
  useStream,
} from '@repo/ui'
import { RadioTowerIcon, RefreshCwIcon, SendIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'

/** 页面内存保留的实时事件条数（历史查询走「告警记录」页，这里只做实时窗口） */
const MAX_EVENTS = 50

/**
 * 连接状态 → 展示文案与指示色。
 * 状态取值来自 `@repo/http-client` 的连接状态机（`@repo/ui` 的 `useStream` 原样透出）。
 */
const STATE_VIEW: Record<string, { text: string; dot: string }> = {
  idle: { text: '未连接', dot: 'bg-muted-foreground' },
  connecting: { text: '连接中', dot: 'bg-warning' },
  open: { text: '已连接', dot: 'bg-success' },
  reconnecting: { text: '重连中', dot: 'bg-warning' },
  closed: { text: '已断开', dot: 'bg-destructive' },
}

const CHANNEL_LABEL: Record<AlertFiredEventModel['channel'], string> = {
  file: '文件',
  lark: '飞书',
  email: '邮件',
}

/**
 * 实时告警：SSE 端到端自检页。
 *
 * 链路：`StreamHub.publish('admin:all', 'alert.fired')`（告警发送后）→ `HttpStreamClient`
 * （`ServerClient.createStream()`，订阅服务端强制注入的身份频道与 `admin:all` 广播频道）
 * → `useStream` 交给 React → 本页即时渲染。点「触发测试告警」即可跑通全链路，无需准备数据。
 */
export default function LiveAlertsPage() {
  const client = useServerClient()
  // generation 自增 → 重建客户端引用 → useStream 关旧连新（页面手动重连）
  const [generation, setGeneration] = useState(0)
  const stream = useMemo(
    () => client.createStream(),
    // generation 是「手动重连」的显式意图：变化即重建引用，useStream 据此关旧连新
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [client, generation],
  )

  const [events, setEvents] = useState<AlertFiredEventModel[]>([])
  const [receivedCount, setReceivedCount] = useState(0)

  const { state, connected } = useStream(stream, {
    // 用前后端共用的数据结构解析：负载不合规直接丢弃，不让脏数据进 UI
    [STREAM_ALERT_FIRED_EVENT]: (data) => {
      const parsed = AlertFiredEventSchema.safeParse(data)
      if (!parsed.success) return
      setEvents((prev) => [parsed.data, ...prev].slice(0, MAX_EVENTS))
      setReceivedCount((count) => count + 1)
    },
  })

  const testMutation = useMutation({
    // file 通道零配置恒可用，保证「自检」在未配置飞书 / 邮件时也能跑通
    mutationFn: () =>
      client.monitor.test({
        title: '实时推送自检',
        message: '来自「实时告警」页的手动测试告警',
        channels: ['file'],
      }),
    onSuccess: () => toastSuccess('测试告警已发送，事件将实时出现在下方列表'),
  })

  const stateView = STATE_VIEW[state] ?? STATE_VIEW.idle

  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-4 sm:py-6">
      <PageToolbar
        title="实时告警"
        description="管理员广播频道 admin:all 的实时事件流（SSE）"
        extra={
          <>
            <Button variant="outline" size="sm" onClick={() => setGeneration((value) => value + 1)}>
              <RefreshCwIcon />
              重连
            </Button>
            <Button
              size="sm"
              disabled={testMutation.isPending}
              onClick={() => testMutation.mutate()}
            >
              <SendIcon />
              触发测试告警
            </Button>
          </>
        }
      />

      {/* 连接与计数：四个微色块（状态 / 收到多少 / 窗口占用 / 最近一条） */}
      <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4">
        <StatusTile label="连接状态">
          <span className="inline-flex items-center gap-1.5">
            <span className={cn('size-1.5 rounded-full', stateView.dot)} />
            {stateView.text}
          </span>
        </StatusTile>
        <StatusTile label="已接收">
          <span className="tabular-nums">{receivedCount}</span>
          <span className="ml-1 text-xs font-normal text-muted-foreground">条</span>
        </StatusTile>
        <StatusTile label="窗口占用">
          <span className="tabular-nums">{events.length}</span>
          <span className="ml-0.5 text-xs font-normal text-muted-foreground">/ {MAX_EVENTS}</span>
        </StatusTile>
        <StatusTile label="最近事件">
          <span className="font-mono text-sm font-normal">
            {events[0] ? dayjs(events[0].sentAt).format('HH:mm:ss') : '-'}
          </span>
        </StatusTile>
      </div>

      {/* 主内容：事件流（最新在上） */}
      <Card className="shrink-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">事件流</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            最新在上，只保留最近 {MAX_EVENTS} 条；完整历史去「告警记录」
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {events.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
              <RadioTowerIcon className="size-6 text-muted-foreground/50" />
              <div className="text-sm text-foreground">
                {connected ? '已连接，等待事件' : '正在建立连接…'}
              </div>
              <p className="max-w-sm text-xs text-muted-foreground">
                {connected
                  ? '点「触发测试告警」发一条演示事件，一秒内会出现在这里；真实告警由监控引擎命中规则后推送。'
                  : '连接建立后，这里的计数与事件流会自动更新。'}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={testMutation.isPending}
                onClick={() => testMutation.mutate()}
              >
                <SendIcon />
                触发一条测试告警
              </Button>
            </div>
          ) : (
            <div className="flex flex-col">
              {events.map((event, index) => (
                <div
                  key={`${event.sentAt}-${index}`}
                  className={cn(
                    'flex items-start gap-4 px-4 py-3 transition-colors hover:bg-surface-2/60',
                    index === 0 && 'bg-surface-2/70',
                  )}
                >
                  <span className="w-16 shrink-0 pt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                    {dayjs(event.sentAt).format('HH:mm:ss')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{event.title}</span>
                      <Tag color="processing">{CHANNEL_LABEL[event.channel]}</Tag>
                      <Tag color={event.status === 'success' ? 'success' : 'error'}>
                        {event.status === 'success' ? '发送成功' : '发送失败'}
                      </Tag>
                    </div>
                    <div className="mt-1 text-xs whitespace-pre-wrap text-muted-foreground">
                      {event.message}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground/70">
                      {event.ruleName}
                      {event.error ? ` · 失败：${event.error}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** 连接/计数小磁贴：标签在上、值在下，值保持主信息的字重 */
function StatusTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-surface-2 px-3.5 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 font-heading text-lg font-medium tracking-tight tabular-nums">
        {children}
      </div>
    </div>
  )
}
