'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Responsive, useContainerWidth } from 'react-grid-layout'
import type { MonitorMetricDefinitionModel, MonitorMetricLatestModel } from '@repo/shared'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DisplayValue,
  PageToolbar,
  RefreshButton,
  Tag,
  cn,
} from '@repo/ui'
import { AnimatedNumber } from '@/components/animated-number'
import { TrendAreaChart, compact } from '@/components/monitor-charts'
import { WaterLevelGauge } from '@/components/water-level-gauge'
import { useServerClient } from '@/lib/server-client'

const SERIES_KEYS = ['request.qps'] as const

export default function MonitorStatusPage() {
  const client = useServerClient()
  const { width, containerRef, mounted } = useContainerWidth()

  const statusQuery = useQuery({
    queryKey: ['monitor', 'engine', 'status'],
    queryFn: () => client.monitor.engine.status(),
    refetchInterval: 30_000,
  })
  const definitionsQuery = useQuery({
    queryKey: ['monitor', 'metric', 'definitions'],
    queryFn: () => client.monitor.metric.definitions(),
  })
  const rulesQuery = useQuery({
    queryKey: ['monitor', 'rule', 'list', 'status'],
    queryFn: () => client.monitor.rule.list({}),
  })
  const seriesQuery = useQuery({
    queryKey: ['monitor', 'status', 'series'],
    queryFn: async () => {
      const results = await Promise.all(
        SERIES_KEYS.map((key) => client.monitor.metric.series({ metricKey: key, limit: 40 })),
      )
      return Object.fromEntries(results.map((result) => [result.metricKey, result.points]))
    },
    refetchInterval: 30_000,
  })
  const latestQuery = useQuery({
    queryKey: ['monitor', 'status', 'latest', definitionsQuery.data?.length ?? 0],
    queryFn: async () => {
      const keys = (definitionsQuery.data ?? []).map((item) => item.key)
      const chunks: string[][] = []
      for (let index = 0; index < keys.length; index += 20) {
        chunks.push(keys.slice(index, index + 20))
      }
      const results = await Promise.all(
        chunks.map((metricKeys) => client.monitor.metric.latest({ metricKeys })),
      )
      return results.flat()
    },
    enabled: (definitionsQuery.data?.length ?? 0) > 0,
    refetchInterval: 30_000,
  })

  // 稳定引用：查询未返回时不能每次渲染都造一个新数组，否则 memo 会反复重算
  const definitions = useMemo(() => definitionsQuery.data ?? [], [definitionsQuery.data])
  const definitionMap = useMemo(
    () => new Map(definitions.map((item) => [item.key, item])),
    [definitions],
  )
  const ruleNames = useMemo(
    () => new Map((rulesQuery.data ?? []).map((item) => [item.ruleKey, item.name])),
    [rulesQuery.data],
  )
  const latestMap = useMemo(() => {
    const map = new Map<string, MonitorMetricLatestModel>()
    for (const item of latestQuery.data ?? []) {
      const current = map.get(item.metricKey)
      if (!current || (current.dimensionType !== 'total' && item.dimensionType === 'total')) {
        map.set(item.metricKey, item)
      }
    }
    return map
  }, [latestQuery.data])
  const statusMetricMap = useMemo(
    () => new Map((statusQuery.data?.metrics ?? []).map((item) => [item.metricKey, item])),
    [statusQuery.data],
  )

  const status = statusQuery.data
  const staleMetrics = (status?.metrics ?? []).filter((metric) => metric.stale)
  // 水位结论：页面首要回答「现在有没有指标越线」，逐条比对阈值
  const breached = (
    [
      ['堆内存', 'process.memoryRatio', 0.85],
      ['HTTP 错误率', 'request.errorRate', 0.05],
      ['HTTP P99', 'request.p99', 1000],
    ] as const
  )
    .filter(([, key, threshold]) => (latestMap.get(key)?.value ?? 0) >= threshold)
    .map(([label]) => label)
  const labelOf = (key: string) => definitionMap.get(key)?.title ?? key
  const chartData = (key: string, scale = 1) =>
    (seriesQuery.data?.[key] ?? []).map((point) => ({
      label: timeLabel(point.windowEnd),
      value: point.value * scale,
    }))

  const metricGroups = useMemo(
    () => [
      {
        label: '系统指标',
        items: definitions.filter((item) => item.category === 'system'),
      },
      {
        label: '业务指标',
        items: definitions.filter((item) => item.category !== 'system'),
      },
    ],
    [definitions],
  )

  const layouts = {
    lg: [
      // 主：余量与异常信号（当前该不该处理）；元信息沉到底部
      { i: 'water', x: 0, y: 0, w: 12, h: 4 },
      { i: 'qps', x: 0, y: 4, w: 7, h: 5 },
      { i: 'stale', x: 7, y: 4, w: 5, h: 5 },
      { i: 'metrics', x: 0, y: 9, w: 12, h: 11 },
      { i: 'rules', x: 0, y: 20, w: 12, h: 5 },
      { i: 'overview', x: 0, y: 25, w: 12, h: 3 },
    ],
    md: [
      { i: 'water', x: 0, y: 0, w: 10, h: 4 },
      { i: 'qps', x: 0, y: 4, w: 6, h: 5 },
      { i: 'stale', x: 6, y: 4, w: 4, h: 5 },
      { i: 'metrics', x: 0, y: 9, w: 10, h: 11 },
      { i: 'rules', x: 0, y: 20, w: 10, h: 5 },
      { i: 'overview', x: 0, y: 25, w: 10, h: 3 },
    ],
    sm: [
      { i: 'water', x: 0, y: 0, w: 6, h: 5 },
      { i: 'qps', x: 0, y: 5, w: 6, h: 5 },
      { i: 'stale', x: 0, y: 10, w: 6, h: 5 },
      { i: 'metrics', x: 0, y: 15, w: 6, h: 12 },
      { i: 'rules', x: 0, y: 27, w: 6, h: 6 },
      { i: 'overview', x: 0, y: 33, w: 6, h: 4 },
    ],
  }

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4 sm:py-6">
      <PageToolbar
        title={
          <span className="inline-flex items-center gap-2">
            监控状态
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-normal tracking-normal text-muted-foreground">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  statusQuery.isError
                    ? 'bg-destructive'
                    : 'animate-pulse bg-success motion-reduce:animate-none',
                )}
              />
              {statusQuery.isError ? '连接异常' : '实时'}
            </span>
          </span>
        }
        description="所有实例采集，主节点评估；卡片可拖拽、可缩放。"
        extra={
          <>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {statusQuery.dataUpdatedAt
                ? `更新于 ${new Date(statusQuery.dataUpdatedAt).toLocaleTimeString('zh-CN', {
                    hour12: false,
                  })}`
                : '等待首次数据'}
            </span>
            <RefreshButton
              className="border-0 bg-surface-2 hover:bg-surface-3"
              loading={statusQuery.isFetching || seriesQuery.isFetching || latestQuery.isFetching}
              onClick={() => {
                void statusQuery.refetch()
                void seriesQuery.refetch()
                void latestQuery.refetch()
              }}
            />
          </>
        }
      />

      <div ref={containerRef} className="min-h-0 w-full">
        {mounted ? (
          <Responsive
            layouts={layouts}
            breakpoints={{ lg: 1100, md: 800, sm: 0 }}
            cols={{ lg: 12, md: 10, sm: 6 }}
            rowHeight={48}
            margin={[12, 12]}
            containerPadding={[0, 0]}
            width={width}
            dragConfig={{ enabled: true, handle: '.drag-handle' }}
            resizeConfig={{ enabled: true }}
          >
            <div key="overview" className="min-w-0">
              <Card className="h-full overflow-hidden">
                <CardHeader className="cursor-move drag-handle pb-0">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm">运行概览</CardTitle>
                    <Tag className="border-0" color={status?.leader ? 'success' : 'default'}>
                      {status?.leader ? '主评估节点' : '跟随节点'}
                    </Tag>
                  </div>
                  <CardDescription>实例身份、时间槽与采集健康度</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-4 pt-1 sm:grid-cols-5">
                  <Kpi label="实例" value={status?.instanceId ?? '-'} mono />
                  <Kpi
                    label="时间槽"
                    value={<AnimatedNumber value={status?.slots.length ?? 0} />}
                  />
                  <Kpi
                    label="指标数"
                    value={<AnimatedNumber value={status?.metrics.length ?? 0} />}
                  />
                  <Kpi
                    label="陈旧指标"
                    value={
                      <AnimatedNumber
                        value={staleMetrics.length}
                        className={staleMetrics.length > 0 ? 'text-destructive' : 'text-success'}
                      />
                    }
                  />
                  <Kpi
                    label="规则数"
                    value={<AnimatedNumber value={status?.rules.length ?? 0} />}
                  />
                </CardContent>
              </Card>
            </div>

            <div key="qps" className="min-w-0">
              <ChartCard
                title="QPS 趋势"
                description={`${labelOf('request.qps')} · 最近 40 个窗口`}
                data={chartData('request.qps')}
                unit=" req/s"
                value={chartData('request.qps').at(-1)?.value}
                format={(value) => value.toFixed(2)}
              />
            </div>

            <div key="water" className="min-w-0">
              <Card className="h-full overflow-hidden">
                <CardHeader className="cursor-move drag-handle pb-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <CardTitle className="text-sm">关键水位</CardTitle>
                      <CardDescription className="text-[11px]">
                        内存、错误率、P99 与今日 token 合并看余量
                      </CardDescription>
                    </div>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
                        breached.length > 0
                          ? 'bg-destructive/10 text-destructive'
                          : 'bg-success/10 text-success',
                      )}
                    >
                      <span
                        className={cn(
                          'size-1.5 rounded-full',
                          breached.length > 0 ? 'bg-destructive' : 'bg-success',
                        )}
                      />
                      {breached.length > 0
                        ? `${breached.join('、')} ${breached.length > 1 ? '均' : ''}越线`
                        : '全部在阈值内'}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-x-2 gap-y-2 pt-0 sm:grid-cols-4">
                  <WaterLevelGauge
                    label="堆内存使用率"
                    value={latestMap.get('process.memoryRatio')?.value}
                    max={1}
                    threshold={0.85}
                    format={(value) => `${(value * 100).toFixed(1)}%`}
                  />
                  <WaterLevelGauge
                    label="HTTP 错误率"
                    value={latestMap.get('request.errorRate')?.value}
                    max={0.2}
                    threshold={0.05}
                    format={(value) => `${(value * 100).toFixed(1)}%`}
                  />
                  <WaterLevelGauge
                    label="HTTP P99"
                    value={latestMap.get('request.p99')?.value}
                    max={2000}
                    threshold={1000}
                    unit="ms"
                    format={(value) => String(Math.round(value))}
                  />
                  <WaterLevelGauge
                    label="今日 AI token"
                    value={latestMap.get('ai.usage.tokens.total')?.value}
                    max={1_000_000}
                    threshold={1_000_000}
                    format={compact}
                    unit="tokens"
                  />
                </CardContent>
              </Card>
            </div>

            <div key="metrics" className="min-w-0">
              <Card className="h-full overflow-hidden">
                <CardHeader className="cursor-move drag-handle pb-2">
                  <CardTitle className="text-sm">指标健康度</CardTitle>
                  <CardDescription>
                    {definitions.length} 个指标 · 数值取最新窗口 · 陈旧指标标红
                  </CardDescription>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 overflow-auto">
                  <div className="flex flex-col gap-5 pb-2">
                    {metricGroups.map((group) => (
                      <section key={group.label}>
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground">
                            {group.label}
                          </h3>
                          <span className="text-[10px] tabular-nums text-muted-foreground/70">
                            {group.items.length} 项
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
                          {group.items.map((definition) => (
                            <MetricTile
                              key={definition.key}
                              definition={definition}
                              latest={latestMap.get(definition.key)}
                              stale={statusMetricMap.get(definition.key)?.stale}
                              lastSampleAt={
                                statusMetricMap.get(definition.key)?.lastSampleAt ?? null
                              }
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div key="stale" className="min-w-0">
              <Card className="h-full overflow-hidden">
                <CardHeader className="cursor-move drag-handle pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm">采集异常</CardTitle>
                    <Tag
                      className="border-0"
                      color={staleMetrics.length > 0 ? 'warning' : 'success'}
                    >
                      {staleMetrics.length > 0 ? `${staleMetrics.length} 项` : '正常'}
                    </Tag>
                  </div>
                  <CardDescription>超过窗口两倍仍未更新，会在评估时跳过</CardDescription>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 overflow-auto p-0">
                  {staleMetrics.length === 0 ? (
                    <div className="flex h-full min-h-24 items-center justify-center px-4 text-xs text-muted-foreground">
                      所有指标都有新鲜样本
                    </div>
                  ) : (
                    <div className="space-y-1 p-2">
                      {staleMetrics.map((metric) => (
                        <div
                          key={metric.metricKey}
                          className="flex items-center gap-3 rounded-md bg-surface-2 px-2.5 py-2 text-xs"
                        >
                          <span className="min-w-0 flex-1 truncate" title={metric.metricKey}>
                            {labelOf(metric.metricKey)}
                          </span>
                          <span className="text-muted-foreground">
                            <DisplayValue
                              type="date"
                              value={metric.lastSampleAt}
                              emptyText="无样本"
                            />
                          </span>
                          <Tag className="border-0" color="warning">
                            陈旧
                          </Tag>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div key="rules" className="min-w-0">
              <Card className="h-full overflow-hidden">
                <CardHeader className="cursor-move drag-handle pb-2">
                  <CardTitle className="text-sm">规则评估</CardTitle>
                  <CardDescription>上次评估与最近触发；名称来自规则定义</CardDescription>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 overflow-auto p-0">
                  <div className="space-y-1 p-2">
                    {(status?.rules ?? []).map((rule) => (
                      <div
                        key={rule.ruleKey}
                        className="flex items-center gap-3 rounded-md bg-surface-2 px-2.5 py-2 text-xs"
                      >
                        <span
                          className={cn(
                            'size-1.5 shrink-0 rounded-full',
                            rule.lastFiredAt ? 'bg-warning' : 'bg-muted-foreground/30',
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate" title={rule.ruleKey}>
                          {ruleNames.get(rule.ruleKey) ?? rule.ruleKey}
                        </span>
                        <span className="hidden text-muted-foreground sm:inline">
                          评估{' '}
                          <DisplayValue
                            type="date"
                            value={rule.lastEvaluatedAt}
                            emptyText="未评估"
                          />
                        </span>
                        <span className="text-muted-foreground">
                          触发{' '}
                          <DisplayValue type="date" value={rule.lastFiredAt} emptyText="从未" />
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </Responsive>
        ) : null}
      </div>
    </div>
  )
}

function Kpi({
  label,
  value,
  mono,
  className,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 rounded-lg bg-surface-4 px-3 py-2', className)}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          'truncate font-heading text-lg font-medium tracking-tight tabular-nums',
          mono && 'font-mono text-sm',
        )}
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </span>
    </div>
  )
}

function ChartCard({
  title,
  description,
  data,
  unit,
  value,
  format,
  color,
  threshold,
  thresholdLabel,
}: {
  title: string
  description: string
  data: Array<{ label: string; value: number }>
  unit: string
  value?: number
  format: (value: number) => string
  color?: string
  threshold?: number
  thresholdLabel?: string
}) {
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader className="cursor-move drag-handle pb-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm">{title}</CardTitle>
            <CardDescription className="mt-1 text-[11px]">{description}</CardDescription>
          </div>
          <span className="shrink-0 font-heading text-xl font-medium tabular-nums tracking-tight">
            {value == null ? '-' : <AnimatedNumber value={value} format={format} />}
            <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">{unit}</span>
          </span>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 pt-0">
        <div className="h-full min-h-32">
          <TrendAreaChart
            data={data}
            unit={unit}
            format={format}
            color={color}
            threshold={threshold}
            thresholdLabel={thresholdLabel}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function MetricTile({
  definition,
  latest,
  stale,
  lastSampleAt,
}: {
  definition: MonitorMetricDefinitionModel
  latest?: MonitorMetricLatestModel
  stale?: boolean
  lastSampleAt: string | Date | null
}) {
  const value = latest?.value
  return (
    <div
      className={cn(
        'group/tile min-w-0 rounded-lg px-2.5 py-2 transition-colors',
        stale ? 'bg-destructive/10 hover:bg-destructive/15' : 'bg-surface-2 hover:bg-surface-3',
      )}
      title={`${definition.key}${latest ? ` · ${latest.windowKey}` : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-[11px] text-muted-foreground">{definition.title}</span>
        {stale ? (
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-destructive">
            <span className="size-1.5 rounded-full bg-destructive" />
            <span className="sr-only">陈旧：</span>
            陈旧
          </span>
        ) : null}
      </div>
      <div className="mt-1 font-heading text-base font-medium tabular-nums tracking-tight">
        {value == null ? '-' : formatMetricValue(value, definition.unit)}
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground/70">
        <span className="truncate font-mono">{definition.key}</span>
        <span className="shrink-0 tabular-nums">
          {lastSampleAt ? timeLabel(lastSampleAt) : '无样本'}
        </span>
      </div>
    </div>
  )
}

const formatMetricValue = (value: number, unit: string): string => {
  if (unit === 'ratio') return `${(value * 100).toFixed(1)}%`
  if (unit === 'ms')
    return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value.toFixed(0)}ms`
  if (unit === 'bytes') return `${(value / 1024 / 1024).toFixed(1)}MB`
  if (unit === 'tokens') return compact(value)
  return compact(value)
}

const timeLabel = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
