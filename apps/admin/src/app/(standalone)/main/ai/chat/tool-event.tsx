'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import { TOOL_EVENT_PART_TYPE, ToolEventMode, parseToolEventPart } from '@repo/shared'
import type { ToolEventPart } from '@repo/shared'
import {
  Badge,
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DictTag,
  cn,
  JsonView,
} from '@repo/ui'
import { ActivityIcon, ChevronDownIcon } from 'lucide-react'

/**
 * 工具自定义事件的前端位置：**渲染器注册表 + 渲染组件**。
 *
 * 三条口径：
 * - **看得见优先**：没注册渲染器的事件走内置兜底（标题 + 事件名徽标 + 折叠 JSON），
 *   协议漂移时宁可多画一张卡，也不静默丢掉（与 `message-row` 的"未知 part 徽标"同一条原则）；
 * - **归并交给 AI SDK**：`state` 由服务端带稳定 id（同 id 后者覆盖前者）、`stream` 不带 id
 *   （按顺序追加），前端**只按 `parts` 顺序遍历**，不自己实现去重；
 * - **事件是过程**：它只走流（`stream-recorder` 不落行），刷新后还要看见的内容必须写进工具出参。
 *
 * 纯逻辑（挑渲染器 / 分桶 / payload 摘要）都在本文件里以纯函数导出，组件只负责画。
 */

/** 通配符：注册时表示"该工具的全部事件"或"全部工具的全部事件" */
export const TOOL_EVENT_ANY = '*'

/** 渲染器拿到的入参 */
export interface ToolEventRendererProps {
  /** 事件 part 原文（含 `seq` / `mode` / `toolKey` 等描述字段） */
  part: ToolEventPart
  /** 便捷取值：= `part.data.payload` */
  payload: unknown
}

/**
 * 事件渲染器：**只画正文**，标题 / 事件名徽标 / `mode` 由卡片统一画。
 *
 * 为什么头部不交给渲染器：头部承担"这是什么事件、有没有异常"的扫读职责，
 * 各工具各画一套必然分叉；工具自己最懂的是 payload 该怎么摆。
 *
 * 它是一个**组件**（渲染时以 `<Renderer />` 挂载，而不是当函数调用）——
 * 这样带 hooks 的自定义渲染器也能正常工作。
 */
export type ToolEventRenderer = (props: ToolEventRendererProps) => ReactNode

/**
 * 渲染器注册表：`toolKey → event → 渲染器`。
 *
 * 用模块级 Map 而不是 React 上下文：注册发生在**模块加载期**（工具的前端渲染器文件
 * import 时就注册），那时还没有组件树。HMR 会重跑模块，故写入是**覆盖式**的（幂等）。
 */
const RENDERERS = new Map<string, Map<string, ToolEventRenderer>>()

/** 注册某个工具某个事件的渲染器（`event` 传 `'*'` = 该工具的全部事件） */
export const registerToolEventRenderer = (
  toolKey: string,
  event: string,
  renderer: ToolEventRenderer,
): void => {
  const byEvent = RENDERERS.get(toolKey) ?? new Map<string, ToolEventRenderer>()
  byEvent.set(event, renderer)
  RENDERERS.set(toolKey, byEvent)
}

/**
 * 清空注册表。
 *
 * 只给测试用：注册表是模块级单例，用例之间会互相污染 —— 尤其 `'*'` / `'*'` 一旦注册就再也
 * 回不到"未注册"状态，靠"用例按顺序执行"来回避是坏味道（谁插一条用例都能把它踩坏）。
 */
export const resetToolEventRenderers = (): void => {
  RENDERERS.clear()
}

/**
 * 挑渲染器；一个都没命中时返回 `undefined`（调用方走内置兜底）。
 *
 * 优先级：精确（`toolKey` + `event`）> 工具通配（`toolKey` + `*`）>
 * 全局精确（`*` + `event`）> 全局通配（`*` + `*`）> 内置兜底。
 */
export const pickToolEventRenderer = (
  toolKey: string,
  event: string,
): ToolEventRenderer | undefined => {
  const byTool = RENDERERS.get(toolKey)
  const exact = byTool?.get(event)
  if (exact) return exact
  const toolAny = byTool?.get(TOOL_EVENT_ANY)
  if (toolAny) return toolAny
  const global = RENDERERS.get(TOOL_EVENT_ANY)
  const globalExact = global?.get(event)
  if (globalExact) return globalExact
  return global?.get(TOOL_EVENT_ANY)
}

/** 事件 part 的最小来源形状（`UIMessage.parts` 的元素都满足它） */
export interface ToolEventSourcePart {
  type: string
  toolCallId?: string
  data?: unknown
}

/** 分桶结果 */
export interface ToolEventGrouping {
  /** 事件 part 下标 → 解析结果（渲染时据此判断"并进工具卡"还是"独立成卡"） */
  byIndex: Map<number, ToolEventPart>
  /** `toolCallId` → 该次工具调用的全部事件（保持 `parts` 顺序） */
  byToolCallId: Map<string, ToolEventPart[]>
}

/**
 * 把消息里的事件 part 分桶：能对上工具卡的按 `toolCallId` 归组，对不上的留给调用方独立成卡。
 *
 * 为什么要先扫一遍"消息里有哪些 `toolCallId`"：事件可能来自**子 agent 内部的工具调用**，
 * 那个 `toolCallId` 在父消息里根本没有对应的工具卡 —— 这类事件必须被认成"无主"，
 * 否则会挂到一张不存在的卡上，在界面上凭空消失。
 *
 * 认不出的 part（`parseToolEventPart` 返回 `null`）不进任何桶：调用方按"未知 part"露徽标。
 */
export const groupToolEventsByToolCall = (
  parts: readonly ToolEventSourcePart[],
): ToolEventGrouping => {
  const toolCallIds = new Set<string>()
  for (const part of parts) {
    if (part.type === TOOL_EVENT_PART_TYPE) continue
    if (typeof part.toolCallId === 'string' && part.toolCallId) toolCallIds.add(part.toolCallId)
  }

  const byIndex = new Map<number, ToolEventPart>()
  const byToolCallId = new Map<string, ToolEventPart[]>()
  parts.forEach((part, index) => {
    if (part.type !== TOOL_EVENT_PART_TYPE) return
    const event = parseToolEventPart(part)
    if (!event) return
    byIndex.set(index, event)
    const toolCallId = event.data.toolCallId
    if (!toolCallId || !toolCallIds.has(toolCallId)) return
    const bucket = byToolCallId.get(toolCallId)
    if (bucket) bucket.push(event)
    else byToolCallId.set(toolCallId, [event])
  })
  return { byIndex, byToolCallId }
}

/** 事件标题：服务端为兜底渲染**自带** `eventTitle`；缺失时退回事件名（宁可看英文名也别空着） */
export const eventTitleOf = (part: ToolEventPart): string =>
  part.data.eventTitle || part.data.event

/**
 * 渲染分组：**一条流水线**（连续的 `stream` 块），或**一个时间点**（单个 `state` 块）。
 *
 * 为什么要分组：AI SDK 的 data part 是**逐块**到达、也逐块留在 `parts` 里的，
 * 一次工具调用的连续流水（`stdout` 几十行、还夹着 `stderr`）在视觉上就是**一整块终端 scrollback**，
 * 不是几十张卡片 —— 一行一盒的话，"实时可读"会直接退化成刷屏，这个能力等于白做。
 */
export interface ToolEventGroup {
  /** React key：首块的事件名 + `seq` + 下标（稳定，排障时还能一眼对上是哪一块） */
  key: string
  /** 组内出现过的不同事件名（按**首次出现顺序**去重）：流水组常见就是 `['stdout']` 或 `['stdout','stderr']` */
  events: string[]
  /** 组的发出方式：`stream` = 一条流水线（可多块），`state` = 一个时间点（必然单块） */
  mode: string
  /** 组内事件（保持 `parts` 原顺序，**绝不重排**） */
  parts: ToolEventPart[]
}

/**
 * 把一次工具调用的事件**按视觉块**分组（纯函数）。
 *
 * 规则只有一条：**相邻的 `stream` 块并进同一组**（不论事件名），`state` 块一律单独成组并**切开流水**。
 * 也就是：`stream` = 一条流水线（合并）；`state` = 一个时间点（必须切开）。
 *
 * 为什么**不再按事件名切**：真实命令的 `stdout` / `stderr` 天然交错（构建、测试、脚本都这样），
 * 按事件名切等于"交错几行就几个盒子"，正是要消灭的东西；而两者的区别**已经写在行的样式里**
 * （普通色 / 警示色），不需要再用块边界重复表达一遍。
 *
 * 仍然保留的两条：`state` 插在中间会把流水**切开**（快照要出现在它到达的位置上，不能被流水糊住）；
 * 组与组内都保持 `parts` 原顺序，**绝不重排**（时间线语义，重排等于篡改历史）。
 */
export const groupToolEventParts = (parts: readonly ToolEventPart[]): ToolEventGroup[] => {
  const groups: ToolEventGroup[] = []
  parts.forEach((part, index) => {
    const { event, mode } = part.data
    const last = groups.at(-1)
    if (last && last.mode === ToolEventMode.Stream && mode === ToolEventMode.Stream) {
      last.parts.push(part)
      // 事件名按首次出现顺序去重：头部要如实列全这一段里出现过哪些事件
      if (!last.events.includes(event)) last.events.push(event)
      return
    }
    groups.push({ key: `${event}-${part.data.seq}-${index}`, events: [event], mode, parts: [part] })
  })
  return groups
}

/** 标量 → 文本；结构化的值返回 `undefined`（由调用方决定折叠 JSON 还是退成一行摘要） */
const scalarText = (value: unknown): string | undefined => {
  if (value === null) return '空'
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return undefined
}

/**
 * 平面对象 payload → 键值对（值全是标量）；只要有一层嵌套就整体返回 `null`。
 *
 * 为什么"整体"退回 JSON：半张键值表 + 半块 JSON 的混排更难读，不如整块折叠起来看原文。
 */
export const flatPayloadEntries = (payload: unknown): Array<[string, string]> | null => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const entries: Array<[string, string]> = []
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const text = scalarText(value)
    if (text === undefined) return null
    entries.push([key, text])
  }
  return entries.length > 0 ? entries : null
}

/** payload 的一行摘要（`stream` 事件"一行一条"用；结构化值退化成 JSON 文本） */
export const payloadSummary = (payload: unknown): string => {
  if (payload === undefined) return '（无负载）'
  if (payload === null) return '空'
  if (typeof payload === 'string') return payload
  const scalar = scalarText(payload)
  if (scalar !== undefined) return scalar
  try {
    return JSON.stringify(payload) ?? ''
  } catch {
    // 流里的 payload 必然可序列化；真遇到环引用也别让界面白屏
    return String(payload)
  }
}

/** payload 的折叠 JSON：结构化负载必须随手可查（兜底渲染不许把内容藏起来） */
const EventJson = ({ payload }: { payload: unknown }) => {
  const [open, setOpen] = useState(false)
  // 标量在上面已经原样显示了，再折一层 JSON 只是噪音
  if (payload === null || typeof payload !== 'object') return null
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronDownIcon className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        {open ? '收起 JSON' : '展开 JSON'}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2">
          <JsonView maxHeight={288} value={payload} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * 内置兜底渲染：没注册渲染器时按 `mode` 画 ——
 * `state` 画当前快照（键值表，嵌套结构退成折叠 JSON），
 * `stream` 画一行（带真实 `seq` 当序号；**不伪造时间**，前端没有任何可信时间源）。
 */
const FallbackEventBody = ({ part }: { part: ToolEventPart }) => {
  const isStream = part.data.mode === ToolEventMode.Stream
  const entries = isStream ? null : flatPayloadEntries(part.data.payload)
  return (
    <div className="flex flex-col gap-1">
      {isStream ? (
        <p className="text-sm break-words whitespace-pre-wrap">
          <span className="mr-2 text-muted-foreground tabular-nums">#{part.data.seq}</span>
          {payloadSummary(part.data.payload)}
        </p>
      ) : entries ? (
        <ul className="flex flex-col gap-1 text-sm">
          {entries.map(([key, value]) => (
            <li key={key} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground">{key}</span>
              <span className="min-w-0 break-all">{value}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm break-words whitespace-pre-wrap">{payloadSummary(part.data.payload)}</p>
      )}
      <EventJson payload={part.data.payload} />
    </div>
  )
}

/** 单个事件的正文：注册过渲染器就用它，否则内置兜底 */
const EventBody = ({ toolKey, part }: { toolKey: string; part: ToolEventPart }) => {
  const Renderer = pickToolEventRenderer(part.data.toolKey || toolKey, part.data.event)
  // 以组件（而非函数调用）挂载：自定义渲染器里可以用 hooks
  return Renderer ? <Renderer part={part} payload={part.data.payload} /> : <FallbackEventBody part={part} />
}

/**
 * 事件标题行：标题 + 事件名徽标 + `mode` —— 认不出的事件靠这一行"露脸"。
 *
 * 头部每组只画一次，所以它描述的是**整组**：标题取**首块**的 `eventTitle`，
 * 事件名徽标**逐个列出** `events`（流水组里 `stdout` / `stderr` 交错时两个都列全 ——
 * 不写"混合"这类含糊文案，扫读时要能直接对上是哪几个事件）。
 *
 * `lineCount` 只在**流水组**的组头传：那一段有多少行是扫读时最想知道的事；
 * 单块（状态快照 / 无主卡片）不传，`stream` 单块因此仍按老规则露 `#seq`。
 */
const ToolEventHeading = ({
  part,
  events,
  lineCount,
}: {
  /** 组内首块：标题取它的 `eventTitle`，`mode` 取它的 `mode` */
  part: ToolEventPart
  /** 组内出现过的事件名（已去重，按首次出现顺序） */
  events: string[]
  lineCount?: number
}) => (
  <div className="flex flex-wrap items-center gap-2 text-sm">
    {part.data.mode === ToolEventMode.Stream && lineCount === undefined ? (
      <span className="text-muted-foreground tabular-nums">#{part.data.seq}</span>
    ) : null}
    <span className="font-medium">{eventTitleOf(part)}</span>
    {events.map((event) => (
      <Badge key={event} variant="outline" className="font-mono">
        {event}
      </Badge>
    ))}
    <DictTag dict={ToolEventMode} value={part.data.mode} emptyText={part.data.mode} />
    {lineCount === undefined ? null : (
      <span className="text-muted-foreground text-xs tabular-nums">{lineCount} 行</span>
    )}
  </div>
)

/**
 * 工具卡里的事件正文：**并进对应工具卡**用（一次工具调用发的事件按 `parts` 顺序排在一起）。
 *
 * 按 `groupToolEventParts` 的**视觉块**渲染，而不是一块一盒：
 * - **流水组**：一整块终端 scrollback —— 外框与内边距由组容器给一次，头部（首块标题 /
 *   去重后的事件名 / mode / 行数）也只出现一次，组内各块依次堆叠、行距收紧；
 *   `stdout` / `stderr` 的区别**靠行级颜色**（普通 / 警示色）表达，不靠块边界；
 * - **状态组（必然单块）**：外观与头部保持原样（快照是"一个时刻的一张脸"，不是流水）；
 * - 组内每一块仍然走 `EventBody`，所以注册过的自定义渲染器照旧生效（`bash` 的终端行不会丢）。
 *
 * 没有事件时返回 `null`，调用方可以无条件挂在 `ToolContent` 末尾而不留空档。
 */
export function ToolEventsBody({
  toolKey,
  parts,
}: {
  /** 工具卡的工具 key（事件自带 `toolKey` 时以事件自带的为准） */
  toolKey: string
  parts: ToolEventPart[]
}) {
  if (parts.length === 0) return null
  const groups = groupToolEventParts(parts)
  return (
    <div className="space-y-2">
      <h4 className="font-medium text-muted-foreground text-xs tracking-wide">事件</h4>
      <div className="flex flex-col gap-1">
        {groups.map((group) => (
          <div
            key={group.key}
            className="flex flex-col gap-1 rounded-md bg-muted/40 px-2 py-1.5"
          >
            <ToolEventHeading
              part={group.parts[0]}
              events={group.events}
              lineCount={group.mode === ToolEventMode.Stream ? group.parts.length : undefined}
            />
            {group.mode === ToolEventMode.Stream ? (
              // 流水组内部**不再各自带框 / 内边距**，只把行距收紧：整段是一块连续输出
              //
              // **刻意不给组内加 `max-h` / 内部滚动**：这个能力的价值就是"边跑边看最后一行"，
              // 组内自滚会把最新行滚出视野（还得人手动往下追），等于把能力抵消掉；
              // 而消息列表本身就在滚，长输出跟着列表滚已经够用。
              <div className="flex flex-col gap-0.5">
                {group.parts.map((part, index) => (
                  <EventBody key={`${part.data.seq}-${index}`} toolKey={toolKey} part={part} />
                ))}
              </div>
            ) : (
              <EventBody toolKey={toolKey} part={group.parts[0]} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 无主事件卡：事件在消息里**找不到对应工具卡**时独立成卡（典型来源：子 agent 内部工具发的、
 * 非流式调用发的）。沿用子助手面板的虚线卡片范式，一眼能看出"它不是某个工具卡的附属"。
 *
 * 默认展开：无主事件本来就少见，藏起来等于"看不见"（兜底的底线是**看得见**）。
 */
export function ToolEventCard({ part }: { part: ToolEventPart }) {
  const [open, setOpen] = useState(true)
  return (
    <Card className="gap-0 py-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className={cn(
            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
            'transition-colors hover:bg-muted/50',
          )}
        >
          <ActivityIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">{eventTitleOf(part)}</span>
          <Badge variant="outline" className="font-mono">
            {part.data.event}
          </Badge>
          <DictTag dict={ToolEventMode} value={part.data.mode} emptyText={part.data.mode} />
          <span className="truncate text-xs text-muted-foreground">
            {part.data.toolKey}
            {part.data.agentKey ? ` · ${part.data.agentKey}` : ''}
          </span>
          <ChevronDownIcon
            className={cn('ml-auto size-4 shrink-0 transition-transform', open && 'rotate-180')}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="px-3 pb-3">
            <EventBody toolKey={part.data.toolKey} part={part} />
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
