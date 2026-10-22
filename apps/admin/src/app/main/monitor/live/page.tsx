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
  PageToolbar,
  Tag,
  cn,
  toastSuccess,
  useStream,
} from '@repo/ui'
import { RefreshCwIcon, SendIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'

/** 页面内存保留的实时事件条数（历史查询走「告警记录」页，这里只做实时窗口） */
const MAX_EVENTS = 50

/**
 * 连接状态 → 展示文案与指示色。
 * 状态取值来自 `@repo/http-client` 的连接状态机（`@repo/ui` 的 `useStream` 原样透出）。
 */
const STATE_VIEW: Record<string, { text: string; dot: string }> = {
  idle: { text: '未连接', dot: 'bg-muted-foreground' },
  connecting: { text: '连接中', dot: 'bg-amber-500' },
  open: { text: '已连接', dot: 'bg-emerald-500' },
  reconnecting: { text: '重连中', dot: 'bg-amber-500' },
  closed: { text: '已断开', dot: 'bg-red-500' },
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
    <div className="flex h-full flex-col gap-6 overflow-auto p-4 sm:p-8">
      <PageToolbar
        title="实时告警"
        description="管理员广播频道 admin:all 的实时事件流（SSE）"
        extra={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setGeneration((value) => value + 1)}
            >
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

      {/* 连接状态 + 计数：嵌入式 hairline 行（与 dashboard 同一语言） */}
      <div className="flex flex-wrap items-center gap-x-7 gap-y-2.5 rounded-lg bg-surface-1 px-3 py-3">
        <span className="inline-flex items-center gap-2 text-xs">
          <span className={cn('size-1.5 rounded-full', stateView.dot)} />
          <span className="text-muted-foreground">{stateView.text}</span>
          <span className="font-mono text-muted-foreground/60">{state}</span>
        </span>
        <span className="inline-flex items-center gap-2 font-mono text-xs text-foreground/80">
          已接收
          <span className="tabular-nums">{receivedCount}</span>
          <span className="text-muted-foreground/70">条</span>
        </span>
        <span className="inline-flex items-center gap-2 font-mono text-xs text-muted-foreground/70">
          窗口
          <span className="tabular-nums">{events.length}</span>/{MAX_EVENTS}
        </span>
      </div>

      {/* 事件流：最新在上 */}
      {events.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          <div className="text-sm text-muted-foreground">
            {connected ? '已连接，等待事件……' : '正在建立连接……'}
          </div>
          <div className="text-xs text-muted-foreground/70">
            点右上角「触发测试告警」，事件应在一秒内出现在这里
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          {events.map((event, index) => (
            <div
              key={`${event.sentAt}-${index}`}
              className="flex items-start gap-4 rounded-lg px-3 py-3 even:bg-surface-1"
            >
              <span className="w-16 shrink-0 pt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                {dayjs(event.sentAt).format('HH:mm:ss')}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{event.title}</span>
                  <Tag color="cyan">{CHANNEL_LABEL[event.channel]}</Tag>
                  <Tag color={event.status === 'success' ? 'green' : 'red'}>
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
    </div>
  )
}
