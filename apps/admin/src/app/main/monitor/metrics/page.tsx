'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DictSelect,
  DisplayValue,
  PageToolbar,
  RefreshButton,
  Tag,
  cn,
} from '@repo/ui'
import { ArrowDownRightIcon, ArrowUpRightIcon } from 'lucide-react'
import { TrendAreaChart } from '@/components/monitor-charts'
import { useServerClient } from '@/lib/server-client'

/** 数值格式化：按指标单位走百分比 / 毫秒 / MB / 缩写 */
function formatValue(value: number, unit: string): string {
  if (unit === 'ratio') return `${(value * 100).toFixed(1)}%`
  if (unit === 'ms') return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`
  if (unit === 'bytes') return `${(value / 1024 / 1024).toFixed(1)}MB`
  return compact(value)
}

function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

const timeLabel = (value: string | Date): string =>
  new Date(value).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })

/**
 * 监控指标：**一个指标最近怎么走、现在多少、在什么区间**。
 *
 * 页面结构按内容主次：
 * - 主：当前值 + 趋势图（回答「这个指标现在怎么样」）；
 * - 次：区间统计与最近窗口明细（支撑判断这个值算不算异常）；
 * - 辅助：指标元信息（key、原始/衍生、单位、窗口、作用域、依赖），一行小字。
 */
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

  // 按窗口时间升序：图表从左到右是时间；明细表再反转成从新到旧
  const points = useMemo(
    () =>
      [...(seriesQuery.data?.points ?? [])].sort(
        (a, b) => new Date(a.windowEnd).getTime() - new Date(b.windowEnd).getTime(),
      ),
    [seriesQuery.data],
  )

  const latest = points.at(-1)
  const previous = points.at(-2)
  const delta = latest && previous ? latest.value - previous.value : null
  const deltaRatio =
    delta != null && previous && previous.value !== 0 ? delta / Math.abs(previous.value) : null

  const stats = useMemo(() => {
    if (points.length === 0) return null
    const values = points.map((point) => point.value)
    return {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((acc, value) => acc + value, 0) / values.length,
      count: values.length,
    }
  }, [points])

  const unit = definition?.unit ?? ''
  const chartData = points.map((point) => ({
    label: timeLabel(point.windowEnd),
    value: point.value,
  }))
  const recent = [...points].reverse()

  return (
    <div className="flex h-full w-full flex-col gap-5 overflow-auto p-4 sm:py-6">
      <PageToolbar
        title="监控指标"
        description="选中一个指标，看它最近的走势、当前值和区间分布。"
        extra={
          <>
            <DictSelect
              className="w-72"
              triggerClassName="w-72"
              placeholder="选择指标"
              options={definitions.map((item) => ({
                label: `${item.title}（${item.key}）`,
                value: item.key,
              }))}
              value={metricKey ?? null}
              onValueChange={(next) => setMetricKey(next ?? undefined)}
            />
            <RefreshButton
              loading={seriesQuery.isFetching || definitionsQuery.isFetching}
              onClick={() => {
                void definitionsQuery.refetch()
                void seriesQuery.refetch()
              }}
            />
          </>
        }
      />

      {/* 主：当前值 + 走势 */}
      <Card className="shrink-0">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-sm">{definition?.title ?? '指标'}</CardTitle>
                {definition ? (
                  <Tag color={definition.kind === 'raw' ? 'processing' : 'default'}>
                    {definition.kind === 'raw' ? '原始' : '衍生'}
                  </Tag>
                ) : null}
                <span className="font-mono text-[11px] text-muted-foreground">
                  {definition?.key}
                </span>
              </div>

              {/* 当前值：这一页的主信息 */}
              <div className="mt-3 flex flex-wrap items-baseline gap-2">
                <span className="font-heading text-3xl font-medium tabular-nums tracking-tight">
                  {latest ? formatValue(latest.value, unit) : '-'}
                </span>
                {unit && unit !== 'ratio' ? (
                  <span className="text-xs text-muted-foreground">{unit}</span>
                ) : null}
                {delta != null ? (
                  <span
                    className="ml-1 inline-flex items-center gap-0.5 text-xs tabular-nums text-muted-foreground"
                    title="与上一个窗口相比"
                  >
                    {delta >= 0 ? (
                      <ArrowUpRightIcon className="size-3.5" />
                    ) : (
                      <ArrowDownRightIcon className="size-3.5" />
                    )}
                    {delta === 0 ? '持平' : formatValue(Math.abs(delta), unit)}
                    {deltaRatio != null ? (
                      <span className="text-muted-foreground/70">
                        （{delta > 0 ? '+' : ''}
                        {(deltaRatio * 100).toFixed(1)}%）
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </div>

              <div className="mt-1.5 text-[11px] text-muted-foreground">
                {latest ? (
                  <>
                    最近窗口 {timeLabel(points[0]!.windowEnd)}–{timeLabel(latest.windowEnd)} · 共{' '}
                    {points.length} 个窗口
                  </>
                ) : seriesQuery.isFetching ? (
                  '加载中…'
                ) : (
                  '还没有样本；等下一轮采集后再看。'
                )}
              </div>
            </div>

            {/* 区间统计：支撑「现在这个值算不算正常」 */}
            {stats ? (
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-right sm:grid-cols-4">
                <StatItem label="最小" value={formatValue(stats.min, unit)} />
                <StatItem label="平均" value={formatValue(stats.avg, unit)} />
                <StatItem label="最大" value={formatValue(stats.max, unit)} />
                <StatItem label="样本" value={String(stats.count)} />
              </div>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="pt-2">
          <div className="h-64">
            <TrendAreaChart
              data={chartData}
              unit={unit === 'ratio' ? '' : ` ${unit}`}
              format={(value) => formatValue(value, unit)}
            />
          </div>
        </CardContent>
      </Card>

      {/* 次：最近窗口明细（从新到旧） */}
      <Card className="shrink-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">最近窗口</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            从新到旧，只列最近 {Math.min(points.length || 0, 15)} 个样本
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {recent.length === 0 ? (
            <p className="px-4 py-6 text-xs text-muted-foreground">暂无样本</p>
          ) : (
            <div>
              {/* 表头：三列含义（窗口结束时间 / 采样值 / 环比） */}
              <div className="grid grid-cols-[1fr_120px_120px] items-center gap-3 bg-surface-2/60 px-4 py-2 text-[11px] text-muted-foreground">
                <span>窗口结束时间</span>
                <span className="text-right">采样值</span>
                <span className="text-right">环比</span>
              </div>
              {recent.slice(0, 15).map((point, index) => {
                const prevPoint = recent[index + 1]
                const diff = prevPoint ? point.value - prevPoint.value : null
                return (
                  <div
                    key={`${point.windowKey}-${point.dimensionType}-${point.dimensionKey}`}
                    className={cn(
                      'grid grid-cols-[1fr_120px_120px] items-center gap-3 px-4 py-2 text-xs',
                      // 最新一个窗口是主行，其余窗口降为背景
                      index === 0 ? 'bg-surface-2 font-medium' : 'text-muted-foreground',
                    )}
                  >
                    <DisplayValue type="date" value={point.windowEnd} />
                    <span className="text-right font-mono tabular-nums">
                      {formatValue(point.value, unit)}
                    </span>
                    <span className="text-right font-mono tabular-nums text-muted-foreground/80">
                      {diff == null || diff === 0
                        ? '-'
                        : `${diff > 0 ? '+' : '−'}${formatValue(Math.abs(diff), unit)}`}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 辅助：指标元信息 */}
      {definition ? (
        <div className="flex flex-wrap items-center gap-x-7 gap-y-1.5 px-1 text-[11px] text-muted-foreground">
          <span>
            类型
            <span className="ml-1 font-mono text-foreground/70">
              {definition.category === 'system' ? '系统' : '业务'} ·{' '}
              {definition.kind === 'raw' ? '原始' : '衍生'}
            </span>
          </span>
          <span>
            单位<span className="ml-1 font-mono text-foreground/70">{definition.unit || '无'}</span>
          </span>
          <span>
            采集 / 窗口
            <span className="ml-1 font-mono text-foreground/70">
              {definition.evaluationIntervalSeconds}s / {definition.windowSeconds}s
            </span>
          </span>
          <span>
            作用域
            <span className="ml-1 font-mono text-foreground/70">
              {definition.scope === 'instance' ? '实例' : '全局'}
            </span>
          </span>
          {definition.dependsOn?.length ? (
            <span>
              依赖
              <span className="ml-1 font-mono text-foreground/70">
                {definition.dependsOn.join('、')}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 区间统计的一格：数字为主，标签为辅 */
function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-heading text-base font-medium tabular-nums tracking-tight">{value}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}
