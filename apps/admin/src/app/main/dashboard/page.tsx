'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useServerClient } from '@/lib/server-client'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@repo/ui'
import type { AgentUsageBucketModel } from '@repo/shared'

/** 统计块：大数字（嵌入式，hairline 左分列，无卡片） */
function StatBlock({
  label,
  value,
  hint,
}: {
  label: string
  value: string | number | null
  hint?: string
}) {
  return (
    <div className="border-l border-border pl-4 first:border-l-0 first:pl-0">
      <div className="font-heading text-2xl font-medium tracking-tight tabular-nums sm:text-3xl">
        {value ?? '-'}
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground">{label}</div>
      {hint ? <div className="mt-1 text-[11px] text-muted-foreground/70">{hint}</div> : null}
    </div>
  )
}

/** 千分位以内原样、千 / 百万缩写（用量数字只看量级，不堆精确位） */
const compactNumber = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/** 毫秒 → 人话（首字 / 平均耗时都不该显示 123456ms） */
const durationText = (ms: number): string => {
  if (!ms) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

const dateLabel = (date: string): string => date.slice(5)

/** 按模型 / agent 的横向占比条（没有图表库，用宽度表达占比） */
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
                    className="h-full rounded-full bg-primary/70"
                    style={{ width: `${Math.max(1, Math.min(100, ratio))}%` }}
                  />
                </div>
              </div>
            )
          })}
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
    queryFn: () =>
      client.monitor.rule.pageQuery({
        page: 1,
        size: 1,
        orderBy: 'createdAt',
        order: 'desc',
      }),
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
  const maxDailyTokens = Math.max(...daily.map((day) => day.totalTokens), 1)
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
        <div className="inline-flex items-center gap-2 text-xs">
          <span
            className={cn(
              'size-1.5 rounded-full',
              health.isSuccess && healthOk ? 'bg-emerald-500' : 'bg-red-500',
            )}
          />
          <span className="text-muted-foreground">
            {health.isSuccess ? (healthOk ? '服务正常' : '服务降级') : '检测中'}
          </span>
        </div>
      </div>

      {/* 数据概览：嵌入式大数字（hairline 分列） */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-3 sm:gap-y-10">
        <StatBlock label="用户" value={users.data?.total ?? null} />
        <StatBlock label="告警规则" value={rules.data?.total ?? null} />
        <StatBlock label="告警记录" value={logs.data?.total ?? null} />
      </div>

      {/* AI 用量：token / 轮数 / 成功率 / 首字延迟 + 按天柱状 + 模型与 agent 占比 */}
      <section className="border-t border-border pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-base font-medium tracking-tight">AI 用量</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              只统计根运行（子 agent 的消耗已并入父运行，不重复计费）
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="inline-flex rounded-md border border-border p-0.5">
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
              <StatBlock label={`近 ${usageDays} 天对话`} value={totals.runs} hint={`${totals.steps} 步模型调用`} />
              <StatBlock
                label={`近 ${usageDays} 天 tokens`}
                value={compactNumber(totals.totalTokens)}
                hint={`入 ${compactNumber(totals.inputTokens)} / 出 ${compactNumber(totals.outputTokens)}`}
              />
              <StatBlock
                label="成功率"
                value={successRate == null ? null : `${successRate}%`}
                hint={`成功 ${totals.succeeded} · 失败 ${totals.failed}`}
              />
              <StatBlock
                label="平均首字延迟"
                value={totals.avgFirstTokenMs ? durationText(totals.avgFirstTokenMs) : null}
                hint={`平均耗时 ${durationText(totals.avgDurationMs)}`}
              />
            </div>

            <div className="mt-5">
              <div className="flex items-end gap-1.5 sm:gap-2" style={{ height: '7rem' }}>
                {daily.map((day) => (
                  <div
                    key={day.date}
                    className="group flex h-full min-w-0 flex-1 flex-col justify-end"
                    title={`${day.date}：${compactNumber(day.totalTokens)} tokens / ${day.runs} 轮`}
                  >
                    <div
                      className="w-full rounded-t-sm bg-primary/40 transition-colors group-hover:bg-primary/70"
                      style={{
                        height: `${Math.max(2, (day.totalTokens / maxDailyTokens) * 100)}%`,
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex justify-between text-[10px] tabular-nums text-muted-foreground/70">
                <span>{daily[0] ? dateLabel(daily[0].date) : ''}</span>
                <span>{daily[daily.length - 1] ? dateLabel(daily[daily.length - 1]!.date) : ''}</span>
              </div>
            </div>

            <div className="mt-5 grid gap-6 border-t border-border pt-4 sm:grid-cols-2">
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
      <div className="border-t border-border pt-5">
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
                  state === 'ok' ? 'bg-emerald-500' : 'bg-red-500',
                )}
              />
              {name}
              <span className="text-muted-foreground/70">
                {state === 'ok' ? 'ok' : 'down'}
              </span>
            </span>
          ))}
          <span className="inline-flex items-center gap-2 font-mono text-xs text-foreground/80">
            <span className="size-1.5 rounded-full bg-indigo-500" />
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
