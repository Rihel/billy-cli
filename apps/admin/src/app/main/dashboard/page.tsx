'use client'

import { useServerClient } from '@/lib/server-client'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@repo/ui'

/** 统计块：大数字（嵌入式，hairline 左分列，无卡片） */
function StatBlock({
  label,
  value,
}: {
  label: string
  value: number | null
}) {
  return (
    <div className="border-l border-border pl-4 first:border-l-0 first:pl-0">
      <div className="font-heading text-2xl font-medium tracking-tight tabular-nums sm:text-3xl">
        {value ?? '-'}
      </div>
      <div className="mt-1.5 text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

export default function DashboardPage() {
  const client = useServerClient()

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
  const todos = useQuery({
    queryKey: ['dashboard', 'todos'],
    queryFn: () =>
      client.todo.pageQuery({
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

  const healthOk = health.data?.status === 'ok'

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
      <div className="grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-4 sm:gap-y-10">
        <StatBlock label="用户" value={users.data?.total ?? null} />
        <StatBlock label="任务" value={todos.data?.total ?? null} />
        <StatBlock label="告警规则" value={rules.data?.total ?? null} />
        <StatBlock label="告警记录" value={logs.data?.total ?? null} />
      </div>

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
