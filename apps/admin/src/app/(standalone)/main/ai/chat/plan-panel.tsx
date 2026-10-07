'use client'

import { useState, type ComponentType } from 'react'
import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Progress,
  cn,
} from '@repo/ui'
// ai-elements 组件**走子路径且带扩展名**（不进 barrel：体积大、按需引入，见 docs/design/ai-agent.md §1）
import {
  Plan as PlanCard,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanFooter,
  PlanHeader,
  PlanTitle,
  PlanTrigger,
} from '@repo/ui/components/ai-elements/plan.tsx'
import {
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  HistoryIcon,
  LoaderCircleIcon,
} from 'lucide-react'

/**
 * 计划面板：渲染 agent 的**任务清单**（规划能力的前端位置）。
 *
 * 协议（后端五个 plan-* 工具的出参，以及时间线里的 `plan` 事件）：
 * - `PlanTask = { id, title, status: 'pending' | 'in_progress' | 'done' | 'blocked', note? }`
 * - `Plan     = { goal, revision, tasks }`
 * - 工具出参 = `{ plan, change: { op, ... } }`（全量计划 + 本次变更摘要）
 *
 * **当前计划 = 最新一次 plan 工具调用的出参**（实时）或时间线里最后一条 `plan` 事件（历史），
 * 所以这里只负责"把一份计划画出来"，取哪一份由调用方（会话页）决定。
 * 历史里被替代的中间版本不进卡片正文，而是折进「变更历史」。
 *
 * 视觉一律走 `@repo/ui` 的语义 token（`text-success` / `text-warning` / `text-primary` …），
 * 不写任何硬编码调色板类（`pnpm check:ui` 会拦，注释里也不行）。
 */

/** 任务状态（与后端协议一致） */
export type PlanStatus = 'pending' | 'in_progress' | 'done' | 'blocked'

export interface PlanTask {
  id: string
  title: string
  status: PlanStatus
  note?: string
}

export interface Plan {
  goal: string
  revision: number
  tasks: PlanTask[]
}

/** 变更摘要：协议只约定 `op`，其余字段按需读（未知 op / 未知字段原样兜底展示） */
export interface PlanChange {
  op: string
  [key: string]: unknown
}

/** 一份计划 + 它是怎么变来的 */
export interface PlanSnapshot {
  plan: Plan
  change?: PlanChange
}

/** 一份计划在消息 parts 里的来源位置（渲染时据此跳过原始工具卡） */
export interface PlanSourcePart {
  /** part 类型：`data-plan`，或工具 part（`tool-<名字>` / `dynamic-tool`） */
  type: string
  id?: string
  /** 只有 `dynamic-tool` 形态才有；`tool-<名字>` 形态的名字在 `type` 里 */
  toolName?: string
  state?: string
  output?: unknown
  data?: unknown
}

/** 一条消息里与计划有关的一切：当前计划 / 更早的版本 / 已被吸收的 part 下标 */
export interface MessagePlan {
  current: PlanSnapshot
  history: PlanSnapshot[]
  consumed: number[]
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

/** 状态别名：新协议四个值，外加旧 `write-plan`（steps[].status）可能出现的写法 */
const STATUS_ALIASES: Record<string, PlanStatus> = {
  pending: 'pending',
  todo: 'pending',
  open: 'pending',
  in_progress: 'in_progress',
  inprogress: 'in_progress',
  running: 'in_progress',
  active: 'in_progress',
  doing: 'in_progress',
  done: 'done',
  complete: 'done',
  completed: 'done',
  success: 'done',
  succeeded: 'done',
  blocked: 'blocked',
  failed: 'blocked',
  error: 'blocked',
}

/** 未知状态值一律当"待办"：宁可少标，也不把没见过的状态误标成已完成 */
export const normalizeStatus = (value: unknown): PlanStatus => {
  if (typeof value !== 'string') return 'pending'
  return STATUS_ALIASES[value.trim().toLowerCase().replace(/[\s-]/g, '_')] ?? 'pending'
}

const STATUS_LABEL: Record<PlanStatus, string> = {
  pending: '待办',
  in_progress: '进行中',
  done: '已完成',
  blocked: '受阻',
}

/** 单个任务（兼容 `title` / `text`，纯字符串任务，缺 id 时按下标补） */
const toTask = (value: unknown, index: number): PlanTask | null => {
  if (typeof value === 'string') {
    const title = value.trim()
    return title ? { id: `t${index + 1}`, title, status: 'pending' } : null
  }
  const task = asRecord(value)
  if (!task) return null
  const title = asText(task.title) ?? asText(task.text)
  if (!title) return null
  const note = asText(task.note)
  return {
    id: asText(task.id) ?? `t${index + 1}`,
    title,
    status: normalizeStatus(task.status),
    ...(note ? { note } : {}),
  }
}

const toTasks = (value: unknown): PlanTask[] =>
  Array.isArray(value)
    ? value.map((task, index) => toTask(task, index)).filter((task): task is PlanTask => task !== null)
    : []

/** 裸计划对象 → Plan（`tasks` 是新协议；`steps` 是旧 `write-plan` 的形态） */
const toPlan = (value: unknown): Plan | null => {
  const record = asRecord(value)
  if (!record) return null
  const goal = asText(record.goal) ?? ''
  const tasks = toTasks(record.tasks ?? record.steps)
  if (!goal && tasks.length === 0) return null
  const revision = typeof record.revision === 'number' && Number.isFinite(record.revision) ? record.revision : 0
  return { goal, revision, tasks }
}

const toChange = (value: unknown): PlanChange | undefined => {
  const change = asRecord(value)
  const op = change ? asText(change.op) : undefined
  return change && op ? ({ ...change, op } as PlanChange) : undefined
}

/**
 * 任意形态的 plan 出参 → `{ plan, change }`；认不出返回 `null`。
 *
 * 要容错的三件事（都是真实流里会出现的）：
 * 1. 工具出参是**字符串**（模型 / provider 把 JSON 序列化了）→ 再解析一次；
 * 2. 出参是 `{ plan, change }` 还是**裸计划**（历史 `plan` 事件的 payload 前后有过两种形态）；
 * 3. 出参是 `null` / 错误对象 → 交给调用方退回普通工具卡，不硬画一张空计划。
 */
export const toPlanSnapshot = (raw: unknown): PlanSnapshot | null => {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return null
    try {
      return toPlanSnapshot(JSON.parse(text) as unknown)
    } catch {
      // 不是 JSON 的字符串：没有可渲染的任务清单，交给普通工具卡展示原文
      return null
    }
  }
  const record = asRecord(raw)
  if (!record) return null

  const nested = toPlan(record.plan)
  if (nested) return { plan: nested, change: toChange(record.change) }

  const plan = toPlan(record)
  return plan ? { plan, change: toChange(record.change) } : null
}

/** 是不是计划类工具（新协议 `plan-*`；`write-plan` 是旧协议的等价物，一并认） */
export const isPlanToolName = (toolName?: string): boolean =>
  typeof toolName === 'string' && (toolName.startsWith('plan-') || toolName === 'write-plan')

/**
 * 工具 part 的工具名 —— **必须同时认两种形态**（实测，见交付报告）：
 *
 * - `dynamic-tool` + `toolName`：AI SDK 对"工具名不静态可知"的调用使用的形态，`history.ts` 合成的也是它；
 * - `tool-<工具名>`：**实时流真正下发的形态**。服务端片段带 `dynamic:false`（Redis 里录到的原文），
 *   SDK 于是按静态工具建 part —— 名字藏在 `type` 里，part 上**没有 `toolName` 字段**。
 *
 * 只认前者会让"当前计划"在实时阶段**永远收集不到**（用户看到的"任务清单不显示"就是这么来的），
 * 刷新后走历史合成又另有一套形态 —— 两条路必须在这里合流。
 */
const toolPartName = (part: PlanSourcePart): string | undefined => {
  if (part.type === 'dynamic-tool') return part.toolName
  return part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : undefined
}

const taskIdOf = (change: PlanChange): string | undefined => {
  const direct = asText(change.taskId) ?? asText(change.task_id) ?? asText(change.id)
  if (direct) return direct
  const task = asRecord(change.task)
  return task ? asText(task.id) : undefined
}

const changeStatusOf = (change: PlanChange): string | undefined => {
  const raw = change.status ?? asRecord(change.task)?.status
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const status = normalizeStatus(raw)
  // 认识的状态给中文；不认识的原样展示，别把没见过的值吞掉
  return STATUS_ALIASES[raw.trim().toLowerCase().replace(/[\s-]/g, '_')] ? STATUS_LABEL[status] : raw
}

/** 未知 `op` 时把可读的标量字段挑出来（最多 3 个），避免变更摘要变成空话 */
const extraFields = (change: PlanChange): string => {
  const skip = new Set(['op', 'plan', 'tasks', 'task'])
  const fields: string[] = []
  for (const [key, value] of Object.entries(change)) {
    if (skip.has(key)) continue
    if (typeof value === 'string' || typeof value === 'number') {
      fields.push(`${key}=${String(value)}`)
      if (fields.length === 3) break
    }
  }
  return fields.length > 0 ? `（${fields.join('，')}）` : ''
}

/**
 * 变更摘要 → 一行中文（如「刚刚：把 t2 标记为已完成」）。
 *
 * `change` 的具体字段协议没有冻结，所以这里**按 op 挑已知字段、未知 op 兜底展示原文**，
 * 不假设 `taskId` / `status` 一定存在。
 */
export const describeChange = (change?: PlanChange, plan?: Plan): string | undefined => {
  if (!change) return undefined
  const op = asText(change.op)
  if (!op) return undefined

  const taskId = taskIdOf(change)
  const title = asText(change.title) ?? (taskId ? plan?.tasks.find((task) => task.id === taskId)?.title : undefined)
  const status = changeStatusOf(change)
  const target = taskId ?? (title ? `「${title}」` : '任务')
  const total = plan?.tasks.length ?? 0

  switch (op) {
    case 'create':
    case 'plan-create':
      return `新建计划（共 ${total} 项）`
    case 'add-task':
    case 'plan-add-task':
      return title ? `新增任务「${title}」` : `新增任务 ${target}`
    case 'remove-task':
    case 'plan-remove-task':
      return title ? `移除任务「${title}」` : `移除任务 ${target}`
    case 'update-task':
    case 'plan-update-task':
      return status ? `把 ${target} 标记为${status}` : `更新任务 ${target}`
    case 'replan':
    case 'plan-replan':
      return `重新规划（共 ${total} 项）`
    default:
      return `${op}${extraFields(change)}`
  }
}

/**
 * 从一条消息的 parts 里挑出"当前计划 + 更早的版本"。
 *
 * 两条数据链路合到同一个入口：
 * - **实时**：工具 part 且工具名是 `plan-*`（形态 `tool-plan-create` 或 `dynamic-tool` + `toolName`），取它的 `output`；
 * - **历史**：`history.ts` 合成的 `data-plan` part，取它的 `data`（`plan` 事件的 payload）。
 *
 * 取舍规则：按 `revision` 取最大者（同版只留一条，历史的 `data-plan` 与工具出参指向同一版时
 * 优先保留带 `change` 的那条）；没有 revision 的旧数据按"最后一个"算。
 * 返回的 `consumed` 是**所有被认出来的计划来源 part 下标** —— 调用方据此跳过原始工具卡
 * （否则同一次计划调用会既出计划卡又出一张裸工具卡；两条链路对同一版各有一份，两份都要吸收），
 * **认不出的出参不在 consumed 里**，确保"看不懂的东西仍然看得见"。
 */
export const collectMessagePlan = (parts: readonly PlanSourcePart[]): MessagePlan | null => {
  const candidates: Array<{ index: number; snapshot: PlanSnapshot }> = []

  parts.forEach((part, index) => {
    if (part.type === 'data-plan') {
      const snapshot = toPlanSnapshot(part.data)
      if (snapshot) candidates.push({ index, snapshot })
      return
    }
    const toolName = toolPartName(part)
    if (!toolName || !isPlanToolName(toolName)) return
    if (part.state !== 'output-available') return
    const snapshot = toPlanSnapshot(part.output)
    if (snapshot) candidates.push({ index, snapshot })
  })
  if (candidates.length === 0) return null

  // 同一 revision 只留一条（历史里 `data-plan` 与工具出参是同一份计划的两种落法）
  const deduped: typeof candidates = []
  const seenRevision = new Map<number, number>()
  for (const candidate of candidates) {
    const revision = candidate.snapshot.plan.revision
    const existing = revision > 0 ? seenRevision.get(revision) : undefined
    if (existing !== undefined) {
      const previous = deduped[existing]
      deduped[existing] = {
        index: candidate.index,
        snapshot: {
          plan: candidate.snapshot.plan,
          change: candidate.snapshot.change ?? previous.snapshot.change,
        },
      }
      continue
    }
    if (revision > 0) seenRevision.set(revision, deduped.length)
    deduped.push(candidate)
  }

  let currentIndex = 0
  for (let index = 1; index < deduped.length; index += 1) {
    if (deduped[index].snapshot.plan.revision >= deduped[currentIndex].snapshot.plan.revision) {
      currentIndex = index
    }
  }

  return {
    current: deduped[currentIndex].snapshot,
    history: deduped.filter((_, index) => index !== currentIndex).map((candidate) => candidate.snapshot),
    // 吸收的是**所有认出来的来源 part**（不是 deduped 里剩下那几条）：
    // 同一版可能同时以 `tool-plan-*` 与 `data-plan` 出现，两条都留着就会重复渲染原始工具卡
    consumed: candidates.map((candidate) => candidate.index),
  }
}

/** 状态 → 图标 + 语义色（一处分发，卡片与"变更历史"共用同一套语义） */
const STATUS_STYLE: Record<
  PlanStatus,
  { label: string; Icon: ComponentType<{ className?: string }>; iconClass: string; badgeClass: string }
> = {
  pending: {
    label: '待办',
    Icon: CircleDashedIcon,
    iconClass: 'text-muted-foreground',
    badgeClass: 'border-border text-muted-foreground',
  },
  in_progress: {
    label: '进行中',
    Icon: LoaderCircleIcon,
    iconClass: 'text-primary',
    badgeClass: 'border-primary/40 text-primary',
  },
  done: {
    label: '已完成',
    Icon: CircleCheckIcon,
    iconClass: 'text-success',
    badgeClass: 'border-success/40 text-success',
  },
  blocked: {
    label: '受阻',
    Icon: CircleAlertIcon,
    iconClass: 'text-warning',
    badgeClass: 'border-warning/40 text-warning',
  },
}

function PlanTaskRow({ task }: { task: PlanTask }) {
  const { label, Icon, iconClass, badgeClass } = STATUS_STYLE[task.status]
  const isDone = task.status === 'done'

  return (
    <li
      className={cn(
        'flex items-start gap-2 rounded-md px-1.5 py-1',
        task.status === 'in_progress' && 'bg-muted/60',
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', iconClass)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('text-sm', isDone && 'text-muted-foreground line-through')}>{task.title}</span>
        {task.note ? <span className="text-xs text-muted-foreground">{task.note}</span> : null}
      </div>
      <Badge variant="outline" className={cn('shrink-0', badgeClass)}>
        {label}
      </Badge>
    </li>
  )
}

export interface PlanPanelProps {
  plan: Plan
  /** 本次变更摘要（放在卡片底部一行小字） */
  change?: PlanChange
  /** 当前计划之前的历史版本（折叠展示 `op + revision`） */
  history?: PlanSnapshot[]
}

/**
 * 计划卡片。
 *
 * 结构用的是 ai-elements 的 `plan.tsx`（`Plan` = Collapsible + Card，配 `PlanHeader` /
 * `PlanTitle` / `PlanDescription` / `PlanAction` / `PlanContent` / `PlanFooter` / `PlanTrigger`），
 * 刚好对上"标题 + 进度 + 可折叠正文 + 页脚"的形态；任务行自己拼 —— `task.tsx` 的
 * `Task` / `TaskItem` 是"可折叠子任务 + 搜索图标"的形态，没有状态 / 备注 / 进度语义，
 * 硬套会把状态图标与标签挤掉（详见交付报告）。
 */
export function PlanPanel({ plan, change, history = [] }: PlanPanelProps) {
  const [historyOpen, setHistoryOpen] = useState(false)

  const total = plan.tasks.length
  const done = plan.tasks.filter((task) => task.status === 'done').length
  const blocked = plan.tasks.filter((task) => task.status === 'blocked').length
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  const revisionLabel = plan.revision > 0 ? `第 ${plan.revision} 版` : '首版'
  const changeText = describeChange(change, plan)

  return (
    <PlanCard defaultOpen>
      <PlanHeader>
        <PlanTitle>{plan.goal || '执行计划'}</PlanTitle>
        {/* PlanDescription / PlanTitle 的 children 类型就是 string（内部可能走 Shimmer），只能传整串 */}
        <PlanDescription>{`已完成 ${done} / 共 ${total}${blocked > 0 ? ` · ${blocked} 项受阻` : ''}`}</PlanDescription>
        <PlanAction className="flex items-center gap-2">
          <Badge variant="outline">{revisionLabel}</Badge>
          <PlanTrigger />
        </PlanAction>
      </PlanHeader>

      <div className="px-(--card-spacing)">
        <Progress value={percent} />
      </div>

      <PlanContent>
        <ul className="flex flex-col gap-0.5">
          {plan.tasks.map((task) => (
            <PlanTaskRow key={task.id} task={task} />
          ))}
          {total === 0 ? <li className="text-xs text-muted-foreground">（还没有任务）</li> : null}
        </ul>

        {history.length > 0 ? (
          <Collapsible
            className="mt-2 border-t border-border pt-2"
            open={historyOpen}
            onOpenChange={setHistoryOpen}
          >
            <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
              <HistoryIcon className="size-3" />
              变更历史（{history.length}）
              <ChevronDownIcon className={cn('ml-auto size-3 transition-transform', historyOpen && 'rotate-180')} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-1 flex flex-col gap-1">
                {history.map((snapshot, index) => (
                  <li
                    key={`${snapshot.plan.revision}-${index}`}
                    className="flex items-start gap-2 text-xs text-muted-foreground"
                  >
                    <span className="shrink-0 tabular-nums">
                      {snapshot.plan.revision > 0 ? `第 ${snapshot.plan.revision} 版` : '首版'}
                    </span>
                    <span className="min-w-0">
                      {describeChange(snapshot.change, snapshot.plan) ?? '无变更摘要'}
                    </span>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </PlanContent>

      {changeText ? (
        <PlanFooter className="py-2 text-xs text-muted-foreground">
          <span>刚刚：{changeText}</span>
        </PlanFooter>
      ) : null}
    </PlanCard>
  )
}

/** 一整个会话里与计划有关的一切（跨消息合流后的结果） */
export interface ConversationPlan {
  /** 当前计划 = 见过的**最高版本**（同一版只留一条） */
  current: PlanSnapshot
  /** 被替代的更早版本（同样按版本去重，供右栏展开「变更历史」） */
  history: PlanSnapshot[]
}

/**
 * 把**整个会话**的计划合流成一份（右栏「任务」tab 用它）。
 *
 * 为什么要跨消息合流，而不是只看最后一条：
 * - 规划工具可能在**任意一轮**被调用（第一轮建清单、第五轮改顺序），计划躺在当时那条消息里；
 * - 一条消息内 `collectMessagePlan` 已经做了"同版去重 + 取最高版本"，这里只需把**多条消息**的结果
 *   再合一次：版本号最高的当当前计划，其余按版本去重后进历史（顺序保持"先出现的在前"）。
 *
 * 判据与消息内那份**完全一致**（都走 `collectMessagePlan`），所以"消息里看到的计划"与
 * "右栏里看到的计划"不会各说各话 —— 两处只有呈现形态不同。
 */
export const conversationPlanOf = (
  messages: readonly { parts: readonly PlanSourcePart[] }[],
): ConversationPlan | null => {
  const found: PlanSnapshot[] = []
  for (const message of messages) {
    const plan = collectMessagePlan(message.parts)
    if (!plan) continue
    found.push(plan.current, ...plan.history)
  }
  if (found.length === 0) return null

  // 按版本去重（首见者胜：同一版可能同时以 `data-plan` 与工具出参出现，保留先出现的那条）
  const byRevision = new Map<number, PlanSnapshot>()
  const unversioned: PlanSnapshot[] = []
  for (const snapshot of found) {
    const revision = snapshot.plan.revision
    if (revision <= 0) {
      unversioned.push(snapshot)
      continue
    }
    const seen = byRevision.get(revision)
    // 同一版有两条时，把「变更摘要」补齐：谁有 `change` 就用谁的那份
    if (!seen) byRevision.set(revision, snapshot)
    else if (!seen.change && snapshot.change) byRevision.set(revision, snapshot)
  }

  let current: PlanSnapshot | undefined
  for (const snapshot of byRevision.values()) {
    if (!current || snapshot.plan.revision >= current.plan.revision) current = snapshot
  }
  // 全是无版本号（revision ≤ 0）的旧数据：按出现顺序取最后一条当当前计划
  if (!current) current = unversioned.at(-1)
  if (!current) return null

  const history = [...byRevision.values()]
    .filter((snapshot) => snapshot !== current)
    .sort((a, b) => a.plan.revision - b.plan.revision)

  return { current, history: [...history, ...unversioned.filter((s) => s !== current)] }
}
