'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useServerClient } from '@/lib/server-client'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@repo/ui'
import type { AgentUsageBucketModel } from '@repo/shared'
import {
  BellRingIcon,
  CircleCheckIcon,
  CoinsIcon,
  MessagesSquareIcon,
  ScrollTextIcon,
  TimerIcon,
  UsersIcon,
} from 'lucide-react'
import { AnimatedNumber } from '@/components/animated-number'
import { DistributionPie, UsageBarChart } from '@/components/monitor-charts'

/**
 * 统计块：大数字 + 可选图标色片。
 * 图标色调只用来分组（品牌色 / 警示色 / 信息色），数字本身保持前景色，避免满屏彩色数字。
 */
function StatBlock({
  label,
  value,
  hint,
  format,
  icon,
  tone = 'brand',
}: {
  label: string
  value: string | number | null
  hint?: string
  format?: (value: number) => string
  icon?: ReactNode
  tone?: 'brand' | 'warning' | 'info' | 'success'
}) {
  const toneClass =
    tone === 'warning'
      ? 'bg-warning/12 text-warning'
      : tone === 'info'
        ? 'bg-info/12 text-info'
        : tone === 'success'
          ? 'bg-success/12 text-success'
          : 'bg-brand/10 text-brand'
  // 平涂淡色（不用渐变：大面积渐变在浅底上会显脏）
  const washClass =
    tone === 'warning'
      ? 'bg-warning/[0.07]'
      : tone === 'info'
        ? 'bg-info/[0.06]'
        : tone === 'success'
          ? 'bg-success/[0.06]'
          : 'bg-brand/[0.06]'

  return (
    <div
      className={cn(
        'rounded-xl px-4 py-3.5 shadow-[0_1px_2px_rgb(23_23_32/0.04)] ring-1 ring-inset ring-black/[0.02] transition-colors dark:bg-surface-2 dark:ring-0',
        washClass,
      )}
    >
      <div className="flex items-center gap-2">
        {icon ? (
          <span className={cn('grid size-6 shrink-0 place-items-center rounded-md', toneClass)}>
            {icon}
          </span>
        ) : null}
        <span className="truncate text-xs text-muted-foreground">{label}</span>
      </div>
      <div className="mt-2.5 font-heading text-2xl font-medium tracking-tight tabular-nums sm:text-3xl">
        {typeof value === 'number' ? (
          <AnimatedNumber value={value} format={format ?? ((next) => String(Math.round(next)))} />
        ) : (
          (value ?? '-')
        )}
      </div>
      {hint ? <div className="mt-1 text-[11px] text-muted-foreground/80">{hint}</div> : null}
    </div>
  )
}

/** 千分位以内原样、千 / 百万缩写（用量数字只看量级，不堆精确位） */
const compactNumber = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(Math.round(value))
}

/** 毫秒 → 人话（首字 / 平均耗时都不该显示 123456ms） */
const durationText = (ms: number): string => {
  if (!ms) return '-'
  const rounded = Math.round(ms)
  return rounded < 1000 ? `${rounded}ms` : `${(rounded / 1000).toFixed(1)}s`
}

const dateLabel = (date: string): string => date.slice(5)

/** 按模型 / agent 的占比：环图看分布，横条看明细 */
function UsageBreakdown({
  title,
  items,
  totalTokens,
}: {
  title: string
  items: AgentUsageBucketModel[]
  totalTokens: number
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        <span className="text-[11px] text-muted-foreground/70">tokens / 轮数</span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">暂无数据</p>
      ) : (
        <div className="grid grid-cols-[104px_1fr] items-center gap-3">
          <div className="h-24">
            <DistributionPie
              data={items.map((item) => ({ name: item.key, value: item.totalTokens }))}
            />
          </div>
          <div className="space-y-2">
          {items.map((item) => {
            const ratio = totalTokens > 0 ? (item.totalTokens / totalTokens) * 100 : 0
            return (
              <div key={item.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="truncate font-mono text-foreground/80" title={item.key}>
                    {item.key}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {compactNumber(item.totalTokens)} / {item.runs}
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-brand/70"
                    style={{ width: `${Math.max(1, Math.min(100, ratio))}%` }}
                  />
                </div>
              </div>
            )
          })}
          </div>
        </div>
      )}
    </div>
  )
}

export default function DashboardPage() {
  const client = useServerClient()
  const [usageDays, setUsageDays] = useState<7 | 30>(7)

  // 全部静默失败（retry 0）：任一模块不可用时统计卡显示 -，不影响整体
  const health = useQuery({
    queryKey: ['dashboard', 'health'],
    queryFn: () => client.monitor.health(),
    retry: 0,
  })
  const users = useQuery({
    queryKey: ['dashboard', 'users'],
    queryFn: () =>
      client.user.pageQuery({
        page: 1,
        size: 1,
        orderBy: 'createdAt',
        order: 'desc',
      }),
    retry: 0,
  })
  const rules = useQuery({
    queryKey: ['dashboard', 'rules'],
    queryFn: () => client.monitor.rule.list({}),
    retry: 0,
  })
  const logs = useQuery({
    queryKey: ['dashboard', 'logs'],
    queryFn: () =>
      client.monitor.log.pageQuery({
        page: 1,
        size: 1,
        orderBy: 'createdAt',
        order: 'desc',
      }),
    retry: 0,
  })
  const usage = useQuery({
    queryKey: ['dashboard', 'ai-usage', usageDays],
    queryFn: () => client.agent.usageSummary({ days: usageDays }),
    retry: 0,
  })

  const healthOk = health.data?.status === 'ok'
  const totals = usage.data?.totals
  const daily = usage.data?.daily ?? []
  const successRate =
    totals && totals.runs > 0 ? Math.round((totals.succeeded / totals.runs) * 100) : null

  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-4 sm:p-8">
      {/* 标题带：左标题 + 右服务状态 pill */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-xl font-medium tracking-tight">
            控制台
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Billy Cli 管理后台，系统运行总览
          </p>
        </div>
        <div
          className={cn(
            'inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium',
            health.isSuccess && healthOk
              ? 'bg-success/10 text-success'
              : health.isSuccess
                ? 'bg-warning/12 text-warning'
                : 'bg-muted text-muted-foreground',
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              health.isSuccess && healthOk
                ? 'bg-success'
                : health.isSuccess
                  ? 'bg-warning'
                  : 'bg-muted-foreground',
            )}
          />
          {health.isSuccess ? (healthOk ? '服务正常' : '服务降级') : '检测中'}
        </div>
      </div>

      {/* 数据概览：嵌入式大数字（hairline 分列） */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-3 sm:gap-y-10">
        <StatBlock
          label="用户"
          value={users.data?.total ?? null}
          icon={<UsersIcon className="size-4" />}
        />
        <StatBlock
          label="告警规则"
          value={rules.data?.length ?? null}
          tone="warning"
          icon={<BellRingIcon className="size-4" />}
        />
        <StatBlock
          label="告警记录"
          value={logs.data?.total ?? null}
          tone="info"
          icon={<ScrollTextIcon className="size-4" />}
        />
      </div>

      {/* AI 用量：token / 轮数 / 成功率 / 首字延迟 + 按天柱状 + 模型与 agent 占比 */}
      <section className="rounded-2xl bg-surface-1 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-base font-medium tracking-tight">AI 用量</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              只统计根运行（子 agent 的消耗已并入父运行，不重复计费）
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="inline-flex rounded-md bg-surface-2 p-0.5">
              {([7, 30] as const).map((days) => (
                <button
                  key={days}
                  type="button"
                  className={cn(
                    'rounded px-2.5 py-1 text-xs transition-colors',
                    usageDays === days
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => setUsageDays(days)}
                >
                  {days} 天
                </button>
              ))}
            </div>
            <Link
              href="/main/ai/audit"
              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              查看明细 →
            </Link>
          </div>
        </div>

        {usage.isLoading ? (
          <p className="mt-4 text-xs text-muted-foreground">正在汇总用量…</p>
        ) : usage.isError || !totals ? (
          <p className="mt-4 text-xs text-muted-foreground">
            AI 用量暂时取不到（模型未配置或服务不可用）
          </p>
        ) : totals.runs === 0 ? (
          <p className="mt-4 text-xs text-muted-foreground">
            近 {usageDays} 天还没有 AI 对话记录。
          </p>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
              <StatBlock
                label={`近 ${usageDays} 天对话`}
                value={totals.runs}
                hint={`${totals.steps} 步模型调用`}
                icon={<MessagesSquareIcon className="size-4" />}
              />
              <StatBlock
                label={`近 ${usageDays} 天 tokens`}
                value={totals.totalTokens}
                format={compactNumber}
                hint={`入 ${compactNumber(totals.inputTokens)} / 出 ${compactNumber(totals.outputTokens)}`}
                icon={<CoinsIcon className="size-4" />}
              />
              <StatBlock
                label="成功率"
                value={successRate}
                format={(next) => `${Math.round(next)}%`}
                hint={`成功 ${totals.succeeded} · 失败 ${totals.failed}`}
                tone="success"
                icon={<CircleCheckIcon className="size-4" />}
              />
              <StatBlock
                label="平均首字延迟"
                value={totals.avgFirstTokenMs || null}
                format={durationText}
                hint={`平均耗时 ${durationText(totals.avgDurationMs)}`}
                tone="info"
                icon={<TimerIcon className="size-4" />}
              />
            </div>

            <div className="mt-5 h-44">
              <UsageBarChart
                data={daily.map((day) => ({ label: dateLabel(day.date), value: day.totalTokens }))}
              />
            </div>

            <div className="mt-5 grid gap-6 pt-4 sm:grid-cols-2">
              <UsageBreakdown
                title="按模型"
                items={usage.data?.byModel ?? []}
                totalTokens={totals.totalTokens}
              />
              <UsageBreakdown
                title="按 Agent"
                items={usage.data?.byAgent ?? []}
                totalTokens={totals.totalTokens}
              />
            </div>
          </>
        )}
      </section>

      {/* 服务状态：嵌入式 hairline 行（checks + uptime mono） */}
      <div className="rounded-xl bg-surface-1 px-4 py-4">
        <div className="flex flex-wrap items-center gap-x-7 gap-y-2.5">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            服务状态
          </span>
          {Object.entries(health.data?.checks ?? {}).map(([name, state]) => (
            <span
              key={name}
              className="inline-flex items-center gap-2 font-mono text-xs text-foreground/80"
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  state === 'ok' ? 'bg-success' : 'bg-destructive',
                )}
              />
              {name}
              <span className="text-muted-foreground/70">
                {state === 'ok' ? 'ok' : 'down'}
              </span>
            </span>
          ))}
          <span className="inline-flex items-center gap-2 font-mono text-xs text-foreground/80">
            <span className="size-1.5 rounded-full bg-success" />
            uptime
            <span className="text-muted-foreground/70">
              {health.data?.uptimeSeconds != null
                ? `${Math.round(health.data.uptimeSeconds)}s`
                : '-'}
            </span>
          </span>
        </div>
      </div>
    </div>
  )
}
