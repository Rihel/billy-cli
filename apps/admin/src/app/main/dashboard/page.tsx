'use client'

import { useServerClient } from '@/lib/server-client'
import { useQuery } from '@tanstack/react-query'
import {
  ActivityIcon,
  ArrowUpRightIcon,
  BellRingIcon,
  ListTodoIcon,
  TerminalIcon,
  UsersIcon,
} from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { cn } from '@repo/ui'

/** 统计卡：mono 大数字 + 品牌图标（数据来自真实接口，失败静默显示 -） */
function StatCard({
  label,
  value,
  icon,
}: {
  label: string
  value: number | null
  icon: ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-xs transition-all hover:border-orange-500/40 hover:shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-accent-foreground">
          {icon}
        </span>
      </div>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums tracking-tight">
        {value ?? '-'}
      </div>
    </div>
  )
}

/** 快速入口：跳转各模块的链接卡 */
function QuickLink({
  title,
  description,
  icon,
  href,
}: {
  title: string
  description: string
  icon: ReactNode
  href: string
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-xs transition-colors hover:border-orange-500/40 hover:bg-accent/40"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {description}
        </span>
      </span>
      <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary" />
    </Link>
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
    <div className="flex h-full flex-col gap-4 overflow-auto p-4 sm:p-6">
      {/* 欢迎区：标题 + 服务状态（真实语义状态点） */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">控制台</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Billy Cli 管理后台，系统运行总览
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          <span
            className={cn(
              'size-1.5 rounded-full',
              health.isSuccess && healthOk ? 'bg-emerald-500' : 'bg-red-500',
            )}
          />
          {health.isSuccess ? (healthOk ? 'service ok' : 'service degraded') : 'checking'}
        </div>
      </div>

      {/* 统计卡：真实数据（分页接口的 total） */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="用户"
          value={users.data?.total ?? null}
          icon={<UsersIcon />}
        />
        <StatCard
          label="任务"
          value={todos.data?.total ?? null}
          icon={<ListTodoIcon />}
        />
        <StatCard
          label="告警规则"
          value={rules.data?.total ?? null}
          icon={<BellRingIcon />}
        />
        <StatCard
          label="告警记录"
          value={logs.data?.total ?? null}
          icon={<ActivityIcon />}
        />
      </div>

      {/* 快速入口：跳转各模块 */}
      <div className="grid content-start gap-4 sm:grid-cols-2">
        <QuickLink
          title="任务管理"
          description="示例模块：游标分页列表"
          icon={<ListTodoIcon />}
          href="/main/todo"
        />
        <QuickLink
          title="自动化"
          description="服务端环境与配置预览"
          icon={<TerminalIcon />}
          href="/main/automation"
        />
        <QuickLink
          title="告警规则"
          description="监控告警规则配置"
          icon={<BellRingIcon />}
          href="/main/monitor/rules"
        />
        <QuickLink
          title="用户管理"
          description="前台用户体系管理"
          icon={<UsersIcon />}
          href="/main/system/users"
        />
      </div>
    </div>
  )
}
