'use client'

import type { Plan } from './plan-panel'
import { Badge, Button, Progress } from '@repo/ui'
import { ListTodoIcon } from 'lucide-react'

/**
 * 主时间线里的**紧凑计划卡**：一句目标 + 进度 + 一个"看完整清单"的入口。
 *
 * 为什么不再把整份任务清单铺在消息里：完整清单（含备注与变更历史）体量大、且会随每一轮变长，
 * 铺在消息流里会把对话切成两半；它现在是**右栏「任务」tab** 的内容（与子助手过程同一个去处）。
 * 消息里只留"有没有计划、做到哪了"这一眼，以及一个能跳过去的按钮 —— 想看细节随时点。
 */
export function PlanSummaryCard({
  plan,
  onOpen,
}: {
  plan: Plan
  /** 打开右栏「任务」tab（会话页负责；不传则只展示不可点） */
  onOpen?: () => void
}) {
  const total = plan.tasks.length
  const done = plan.tasks.filter((task) => task.status === 'done').length
  const blocked = plan.tasks.filter((task) => task.status === 'blocked').length
  const running = plan.tasks.find((task) => task.status === 'in_progress')
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <ListTodoIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={plan.goal}>
          {plan.goal || '执行计划'}
        </span>
        <Badge variant="outline" className="shrink-0 tabular-nums">
          已完成 {done} / 共 {total}
        </Badge>
        {blocked > 0 ? (
          <Badge variant="outline" className="shrink-0 border-warning/40 text-warning">
            {blocked} 项受阻
          </Badge>
        ) : null}
        {onOpen ? (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={onOpen}>
            查看清单
          </Button>
        ) : null}
      </div>
      <Progress value={percent} />
      {/* 正在做哪一项：一屏内最有用的那一句（没有进行中的就不占位） */}
      {running ? (
        <span className="truncate text-xs text-muted-foreground" title={running.title}>
          正在做：{running.title}
        </span>
      ) : null}
    </div>
  )
}
