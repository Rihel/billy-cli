'use client'

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export interface TrendPoint {
  label: string
  value: number
}

const axisStyle = { fontSize: 10, fill: 'var(--muted-foreground)' }

/** 时间序列面积图：QPS / 内存 / 错误率都用它 */
export function TrendAreaChart({
  data,
  color = 'var(--chart-1)',
  unit = '',
  format = (value) => String(value),
  threshold,
  thresholdLabel,
}: {
  data: TrendPoint[]
  color?: string
  unit?: string
  format?: (value: number) => string
  threshold?: number
  thresholdLabel?: string
}) {
  if (data.length === 0) {
    return <EmptyChart text="还没有样本" />
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={40} />
        {threshold !== undefined ? (
          <ReferenceLine
            y={threshold}
            stroke="var(--warning)"
            strokeDasharray="4 4"
            label={{
              value: thresholdLabel ?? `阈值 ${format(threshold)}${unit}`,
              position: 'insideTopRight',
              fill: 'var(--muted-foreground)',
              fontSize: 10,
            }}
          />
        ) : null}
        <Tooltip
          cursor={{ stroke: 'var(--border)' }}
          contentStyle={{
            borderRadius: 8,
            border: 'none',
            background: 'var(--popover)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.14)',
            fontSize: 12,
          }}
          formatter={(value) => [`${format(Number(value))}${unit}`, '']}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          fill={color}
          fillOpacity={0.14}
          isAnimationActive
          animationDuration={550}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

/** 按天用量柱状图 */
export function UsageBarChart({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) return <EmptyChart text="还没有数据" />
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={false} />
        <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={40} />
        <Tooltip
          cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
          contentStyle={{
            borderRadius: 8,
            border: 'none',
            background: 'var(--popover)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.14)',
            fontSize: 12,
          }}
          formatter={(value) => [compact(Number(value)), 'tokens']}
        />
        <Bar dataKey="value" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={32} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** 占比 / 分布环图 */
export function DistributionPie({
  data,
  colors = [
    'var(--chart-1)',
    'var(--chart-2)',
    'var(--chart-3)',
    'var(--chart-4)',
    'var(--chart-5)',
  ],
}: {
  data: Array<{ name: string; value: number }>
  colors?: string[]
}) {
  const total = data.reduce((sum, item) => sum + item.value, 0)
  if (total === 0) return <EmptyChart text="暂无数据" />
  // 只有一项时整圈是一种颜色，留缝反而像被切掉一块
  const gap = data.length > 1 ? 2 : 0
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius="58%"
          outerRadius="82%"
          paddingAngle={gap}
          stroke={gap ? "var(--background)" : "none"}
          strokeWidth={2}
          isAnimationActive={false}
        >
          {data.map((item, index) => (
            <Cell key={item.name} fill={colors[index % colors.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            borderRadius: 8,
            border: 'none',
            background: 'var(--popover)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.14)',
            fontSize: 12,
          }}
          formatter={(value, name) => [compact(Number(value)), String(name)]}
        />
      </PieChart>
    </ResponsiveContainer>
  )
}

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      {text}
    </div>
  )
}

export const compact = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
