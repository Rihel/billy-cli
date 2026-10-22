'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DisplayValue,
  RefreshButton,
  Tag,
  cn,
} from '@repo/ui'
import { useServerClient } from '@/lib/server-client'

/** 指标历史：最近 60 个窗口的趋势 + 原始点表；不引入图表库，用横向条表达相对大小 */
export default function MonitorMetricsPage() {
  const client = useServerClient()
  const [metricKey, setMetricKey] = useState<string | undefined>()

  const definitionsQuery = useQuery({
    queryKey: ['monitor', 'metric', 'definitions'],
    queryFn: () => client.monitor.metric.definitions(),
  })
  const definitions = definitionsQuery.data ?? []

  useEffect(() => {
    if (!metricKey && definitions.length > 0) setMetricKey(definitions[0].key)
  }, [definitions, metricKey])

  const definition = definitions.find((item) => item.key === metricKey)
  const seriesQuery = useQuery({
    queryKey: ['monitor', 'metric', 'series', metricKey],
    queryFn: () =>
      client.monitor.metric.series({
        metricKey: metricKey!,
        limit: 60,
      }),
    enabled: Boolean(metricKey),
  })

  const points = seriesQuery.data?.points ?? []
  const max = useMemo(
    () => Math.max(...points.map((point) => point.value), 1),
    [points],
  )

  return (
    <div className="flex h-full w-full flex-col gap-6 overflow-auto p-4 sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">监控指标</h1>
          <p className="text-sm text-muted-foreground">
            最近 60 个窗口的采集值；衍生指标由同窗口原始指标计算。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-9 w-72 rounded-md bg-surface-2 px-3 text-sm"
            value={metricKey ?? ''}
            onChange={(event) => setMetricKey(event.target.value)}
          >
            {definitions.map((item) => (
              <option key={item.key} value={item.key}>
                {item.title}（{item.key}）
              </option>
            ))}
          </select>
          <RefreshButton
            loading={seriesQuery.isFetching || definitionsQuery.isFetching}
            onClick={() => {
              void definitionsQuery.refetch()
              void seriesQuery.refetch()
            }}
          />
        </div>
      </div>

      {definition ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              {definition.title}
              <Tag color="cyan">{definition.kind === 'raw' ? '原始' : '衍生'}</Tag>
              <Tag>{definition.unit}</Tag>
              <Tag>
                {definition.evaluationIntervalSeconds}s / {definition.windowSeconds}s
              </Tag>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">{definition.description}</p>
            {definition.dependsOn?.length ? (
              <p className="font-mono text-xs text-muted-foreground">
                依赖：{definition.dependsOn.join('、')}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">最近值</h2>
        {points.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {seriesQuery.isFetching ? '加载中…' : '还没有样本；等下一轮采集后再看。'}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg bg-surface-1">
            {[...points].reverse().map((point, index) => (
              <div
                key={`${point.windowKey}-${point.instanceId}-${point.dimensionType}-${point.dimensionKey}`}
                className={cn(
                  'grid grid-cols-[170px_1fr_90px] items-center gap-3 px-3 py-2 text-xs',
                  // 最新一个窗口是主信息，其余窗口降为背景
                  index === 0 ? 'bg-surface-2 font-medium' : 'text-muted-foreground',
                )}
              >
                <DisplayValue type="date" value={point.windowEnd} />
                <div className="h-2 overflow-hidden rounded bg-muted">
                  <div
                    className="h-full rounded bg-brand/70"
                    style={{ width: `${Math.max((point.value / max) * 100, 2)}%` }}
                  />
                </div>
                <span className="text-right font-mono tabular-nums">{formatValue(point.value)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const formatValue = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(4)
