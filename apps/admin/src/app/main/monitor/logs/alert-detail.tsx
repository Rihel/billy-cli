'use client'

import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { MonitorAlertModel } from '@repo/shared'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DisplayValue,
  Tag,
} from '@repo/ui'
import { useServerClient } from '@/lib/server-client'

export function AlertDetailDialog({
  alert,
  open,
  onClose,
}: {
  alert: MonitorAlertModel | null
  open: boolean
  onClose: () => void
}) {
  const client = useServerClient()
  const detailQuery = useQuery({
    queryKey: ['monitor', 'alert', 'detail', alert?.id],
    queryFn: () => client.monitor.alert.detail({ alertId: alert!.id }),
    enabled: open && Boolean(alert),
  })

  const detail = detailQuery.data

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{alert?.ruleName ?? '告警详情'}</DialogTitle>
        </DialogHeader>

        {alert ? (
          <div className="flex flex-col gap-4 text-sm">
            <div className="grid grid-cols-2 gap-3 rounded-lg bg-surface-1 p-4">
              <Info label="规则 key" value={alert.ruleKey} mono />
              <Info label="级别" value={<Tag color={alert.level === 'critical' ? 'error' : alert.level === 'error' ? 'error' : 'warning'}>{alert.level}</Tag>} />
              <Info label="状态" value={<Tag color={alert.status === 'firing' ? 'error' : 'success'}>{alert.status === 'firing' ? '未恢复' : '已恢复'}</Tag>} />
              <Info label="主体" value={alert.subjectId} mono />
              <Info label="首次告警" value={<DisplayValue type="date" value={alert.firstFiredAt} />} />
              <Info label="最近命中" value={<DisplayValue type="date" value={alert.lastFiredAt} />} />
              <Info label="恢复时间" value={<DisplayValue type="date" value={alert.recoveredAt} emptyText="未恢复" />} />
              <Info label="持续时长" value={formatDuration(alert.durationMs)} />
              <Info label="最近值" value={alert.value ?? '-'} />
              <Info label="阈值" value={alert.threshold ?? '-'} />
            </div>

            <Snapshot title="首次快照" value={alert.firstSnapshot} />
            <Snapshot title="最近快照" value={alert.lastSnapshot} />

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">发送记录</h3>
              {detail?.deliveries.length ? (
                <div className="overflow-hidden rounded-lg bg-surface-1">
                  {detail.deliveries.map((delivery) => (
                    <div
                      key={delivery.id}
                      className="flex flex-wrap items-center gap-3 px-3 py-2 text-xs even:bg-surface-2"
                    >
                      <Tag color="cyan">{delivery.channel}</Tag>
                      <Tag color={delivery.status === 'success' ? 'success' : 'error'}>
                        {delivery.status === 'success' ? '成功' : '失败'}
                      </Tag>
                      <DisplayValue type="date" value={delivery.sentAt} />
                      {delivery.error ? (
                        <span className="text-destructive">{delivery.error}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">还没有发送记录。</p>
              )}
            </section>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Info({
  label,
  value,
  mono,
}: {
  label: string
  value: ReactNode
  mono?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-xs' : undefined}>{value}</span>
    </div>
  )
}

function Snapshot({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <pre className="max-h-60 overflow-auto rounded-lg bg-surface-1 p-3 text-xs">
        {value ? JSON.stringify(value, null, 2) : '无'}
      </pre>
    </section>
  )
}

function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined) return '-'
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分钟`
}
