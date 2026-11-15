'use client'

import { useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AgentRunModel } from '@repo/shared'
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger, cn } from '@repo/ui'
import { BotIcon, LoaderCircleIcon, MessagesSquareIcon } from 'lucide-react'
import { loadWholeRuns, loadWholeTimeline, type ServerClient } from './data'
import { toUIMessages } from './history'
import { ChatMessage } from './message-row'
import { SubAgentLiveView, statusLabel, statusVariant } from './sub-agent-panel'
import {
  isSubAgentActive,
  subAgentTabLabels,
  subAgentTabs,
  type SubAgentTab,
} from './sub-agent-live'
import { toMessageState, useLiveSubAgents } from './chat-session'
import { durationText, tokenText } from './format'

/** 主会话 tab 的取值；子 agent tab 与它同处一个 `Tabs`，值取子 run 的 id */
export const MAIN_SESSION_TAB = 'main'

/**
 * `run/list` 的缓存键。
 *
 * 会话页重建历史时也走同一个键（用 `fetchQuery`）：tab 条**每次挂载都要知道有哪些子 agent**，
 * 若会话页与 tab 条各发一次 `run/list`，同一页就白打了一次。
 */
export const runsQueryKey = (conversationId: string) => ['ai', 'runs', conversationId] as const

/** 有子助手在跑时，`run/list` 的轮询间隔（毫秒）；为什么取 4s 见下方 `runsQuery` 的注释 */
const SUB_AGENT_POLL_INTERVAL = 4_000

/**
 * 会话页**主区顶部的 tab 条**：第一个是主会话，其余每个子 agent 一个 tab。
 *
 * ## 为什么从右栏挪到这里
 *
 * 子助手的过程原先在右栏「子 agent」tab 里，但右栏是**窄栏**（默认 40%、最宽 55%），
 * 一段带推理与十几次工具往返的过程挤在里面，长行被折得很碎、只能不停上下滚；
 * 而它本身就是"另一条会话"，和主会话是**平级**的东西 —— 平级的东西用平级的 tab 表达。
 * 同时右栏回到它该干的事（系统指令 / 技能 / 任务 / 文件这些**旁证**），
 * 不再混着一个需要主对话等宽的过程视图。
 *
 * ## 三条硬约束
 *
 * 1. **主会话常驻挂载**（`keepMounted`）：切到子 agent 再切回来，输入框里没发出去的草稿、
 *    时间线滚动位置都还在。子 agent 只有**当前那一个**挂载（切走就卸载）——
 *    多个子 run 的完整时间线一起查是白花的请求（这也是原先右栏的做法）。
 * 2. **不因"子助手开跑"自动切 tab**：它只在自己的 tab 上转圈，不抢用户正在读的主时间线。
 *    原先"有子助手在跑就自动展开右栏并停在子 agent tab"的做法正是抢视图的反例。
 *    唯一例外是**出现待回答的问题**（阻塞操作）：那种情况由会话页切回主会话（见
 *    `chat-conversation.tsx` 的 `hasActiveQuestion` effect）。
 * 3. **选中态由会话页持有**（受控）：主时间线上的子助手卡片要把用户送到对应 tab，
 *    两边得是同一份选中态；tab 的最终归属仍在用户手里，会话页只做"请求切换"。
 *
 * ## 两条数据链路（运行中 / 已结束）
 *
 * - **运行中**：本组件自己订阅会话 store 的实时数据（`onData` 收的 `data-sub-agent*` 块），
 *   tab 立刻就有内容、且**边跑边长** —— 不必等库里的时间线落完，也不新增任何后端接口；
 * - **已结束 / 刷新后**：按需拉该子 run 的完整时间线（`loadWholeTimeline` + 主对话同一套渲染）。
 *
 * 订阅放在**这一层**而不是会话页：实时增量 100ms 合并通知一次，只有 tab 条这个子树跟着更新；
 * 主会话内容以 `children` 传进来（引用稳定），React 会直接跳过它的重渲染。
 */
export function SessionTabs({
  client,
  conversationId,
  activeTab,
  onTabChange,
  children,
}: {
  client: ServerClient
  /** 新会话还没有 id：此时既没有子 run，也没有可查的运行记录 */
  conversationId?: string
  /** 当前选中的 tab：`MAIN_SESSION_TAB` 或某个子 run 的 id */
  activeTab: string
  onTabChange: (value: string) => void
  /** 主会话的内容（时间线 + 输入框上方的 dock + 输入框）：**常驻挂载**，切走时只是隐藏 */
  children: ReactNode
}) {
  /**
   * 本次运行中各子助手的实时过程。订阅在 tab 条这一层：实时增量只让这里更新，
   * 主会话（`children`）不受影响 —— 否则每一帧都会带着整条时间线重渲染。
   */
  const liveSubAgents = useLiveSubAgents()

  /**
   * 运行列表在这一层取：tab 条要它才知道"有哪些子 agent"，内容区也要用同一份数据。
   *
   * 有子助手在跑时**轮询刷新**：子 run 是起跑那一刻才落库的，一次性查询会出现
   * "实时块里已经有它、库里这份还没有"的窗口（那会影响跑完之后能否切到完整时间线）。
   * 跑完就停（`false`），不给空闲页面留无谓请求。
   *
   * **为什么是 4 秒**：子 run 的起止间隔通常是秒级到分钟级，4s 足够在用户刚看到子助手卡片之后
   * 就把库里的 run 记录对齐（切到完整时间线的前提）；而 `run/list` 只是一页 100 条的索引查询、
   * 且只在有子助手在跑的那段时间发 —— 有感知、又不会在后台空转打库。
   */
  const runsQuery = useQuery({
    queryKey: runsQueryKey(conversationId ?? 'none'),
    queryFn: () => loadWholeRuns(client, conversationId as string),
    enabled: Boolean(conversationId),
    refetchInterval: liveSubAgents.some(isSubAgentActive) ? SUB_AGENT_POLL_INTERVAL : false,
  })
  /** 只要子 run：根 run 是主会话本身，已经在第一个 tab 里了 */
  const subRuns = useMemo(
    () => (runsQuery.data ?? []).filter((run) => run.parentRunId !== null),
    [runsQuery.data],
  )
  /** 库里的子 run 与实时数据合流成 tab（谁先有就先用谁的，见 `subAgentTabs`） */
  const tabs = useMemo(() => subAgentTabs(subRuns, liveSubAgents), [subRuns, liveSubAgents])
  const labels = useMemo(() => subAgentTabLabels(tabs), [tabs])

  /**
   * 兜底回落主会话：当前值可能是「已经消失的子 run」或「嵌套委派的 run」
   * （子助手的过程里再委派时，卡片持有的是孙 run 的 id，它不在本层 tab 列表里）。
   * 让 `Tabs` 拿到一个不存在的值时面板会空白一片，宁可回到主会话。
   */
  const current =
    activeTab === MAIN_SESSION_TAB || tabs.some((tab) => tab.runId === activeTab)
      ? activeTab
      : MAIN_SESSION_TAB

  return (
    <Tabs
      value={current}
      onValueChange={(value) => onTabChange(String(value))}
      className="flex min-h-0 flex-1 flex-col gap-1.5"
    >
      {/*
        标签条：**按内容宽度**排、超宽横向滚，整条下面一条明显的分隔线与 timeline 划开。
        - `flex-none` + `w-max`：每个 tab 自己的宽度（不拉伸成等宽大按钮）；
        - 滚动容器放在**外层**：`TabsList` 固定 h-8，横向滚动条挤在它内部会把标签压扁；
        - 外层显式 `overflow-y-hidden`：`overflow-x-auto` 会把另一轴也算成 auto，
          横向滚动条吃掉的高度又长出竖直滚动条（踩过）；
        - **不写 `scrollbar-none`**：这里的横向滚动条是给用户看的可滚动手感，
          滑块视觉仍由全局 `OverlayScrollbar` 统一画（原生只留拖拽热区）。
      */}
      <div className="shrink-0 overflow-x-auto overflow-y-hidden border-b border-border pb-1">
        <TabsList className="w-max justify-start">
          <TabsTrigger value={MAIN_SESSION_TAB} className="flex-none">
            <MessagesSquareIcon className="size-3.5" />
            主会话
          </TabsTrigger>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.runId} value={tab.runId} className="flex-none">
              {/* 运行态与卡片同一套观感：转圈 + 主色（一眼看出哪个子 agent 还在跑） */}
              {tab.active ? (
                <LoaderCircleIcon className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
              ) : (
                <BotIcon className="size-3.5" />
              )}
              {labels.get(tab.runId)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {/* 失败要说出来：tab 条缺了子 agent 会被当成"它没跑过"，这比报错更难排 */}
      {runsQuery.isError ? (
        <p className="shrink-0 px-1 text-[11px] leading-4 text-destructive">
          子 agent 运行记录加载失败：
          {runsQuery.error instanceof Error ? runsQuery.error.message : String(runsQuery.error)}
        </p>
      ) : null}

      {/*
        主会话：`keepMounted` 保住草稿与滚动位置。
        显隐**不能只靠 `keepMounted`**：Base UI 隐藏时给的是 `hidden` 属性（UA 的 `display:none`），
        而作者样式里的 `flex` 会盖掉它 —— 所以这里按选中态自己给 `hidden` / `flex`。
      */}
      <TabsContent
        value={MAIN_SESSION_TAB}
        keepMounted
        className={cn('min-h-0 flex-1', current === MAIN_SESSION_TAB ? 'flex flex-col' : 'hidden')}
      >
        {children}
      </TabsContent>

      {tabs.map((tab) =>
        conversationId ? (
          // 只挂当前这一个 tab 的内容：多个子 run 一起查时间线是白花的请求
          // 与主时间线的 `ConversationContent`（p-3）保持同一边距，切 tab 不跳版
          <TabsContent
            key={tab.runId}
            value={tab.runId}
            className="min-h-0 flex-1 overflow-auto p-3"
          >
            <SubAgentTabContent client={client} conversationId={conversationId} tab={tab} />
          </TabsContent>
        ) : null,
      )}
    </Tabs>
  )
}

/**
 * 一个 tab 的内容：**运行中看实时，已结束看库里**。
 *
 * 判据刻意写成"先看实时"：库里的时间线是**按需**查的、而且要等这一轮落库才完整，
 * 而实时块当下就有 —— 运行中直接查库会看到一段半成品（甚至空白）。
 * 只有在"实时说它已经收尾、库里也确实有这个 run"时才切到库里那份完整记录。
 */
function SubAgentTabContent({
  client,
  conversationId,
  tab,
}: {
  client: ServerClient
  conversationId: string
  tab: SubAgentTab
}) {
  if (tab.live && (tab.active || !tab.run)) {
    return <SubAgentLiveView live={tab.live} />
  }
  if (tab.run) {
    return <SubRunView client={client} conversationId={conversationId} run={tab.run} />
  }
  return <p className="text-xs text-muted-foreground">这个子助手还没有可显示的过程记录。</p>
}

/** 一个子 run 的完整过程（元信息 + 与主对话同一套渲染） */
function SubRunView({
  client,
  run,
}: {
  client: ServerClient
  conversationId: string
  run: AgentRunModel
}) {
  const query = useQuery({
    queryKey: ['ai', 'timeline', run.conversationId, 'run', run.id],
    queryFn: async () => {
      // 子 run 挂在子会话上：时间线要按 run 自己的 conversationId 拉
      const items = await loadWholeTimeline(client, run.conversationId, run.id)
      // 只映射这一个子 run：主 run 的消息不该出现在子助手的 tab 里
      return toUIMessages(items, [run], { onlyRunIds: [run.id] })
    },
  })
  const messages = query.data ?? []
  const totalTokens = run.usage?.totalTokens

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Badge variant={statusVariant(run.status)}>{statusLabel[run.status] ?? run.status}</Badge>
        <span>
          {run.stepCount} 步 / {run.toolCallCount} 次工具 · {durationText(run.durationMs)}
          {typeof totalTokens === 'number' ? ` · ${tokenText(totalTokens)} token` : ''}
        </span>
      </div>
      {run.errorMessage ? <p className="text-xs text-destructive">{run.errorMessage}</p> : null}
      {query.isLoading ? (
        <p className="text-xs text-muted-foreground">正在加载子助手过程…</p>
      ) : query.isError ? (
        <p className="text-xs text-destructive">
          加载失败：{query.error instanceof Error ? query.error.message : String(query.error)}
        </p>
      ) : messages.length === 0 ? (
        <p className="text-xs text-muted-foreground">这个子助手没有留下可显示的过程记录。</p>
      ) : (
        messages.map((message) => (
          <ChatMessage key={message.id} message={toMessageState(message)} streaming={false} />
        ))
      )}
    </div>
  )
}
