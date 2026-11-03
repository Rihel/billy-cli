'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AgentRunModel } from '@repo/shared'
import {
  Badge,
  IconText,
  Markdown,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toastError,
  toastSuccess,
} from '@repo/ui'
import { BotIcon, CopyIcon, ListTodoIcon, LoaderCircleIcon, ScrollTextIcon } from 'lucide-react'
import { loadWholeRuns, loadWholeTimeline, type ServerClient } from './data'
import { toUIMessages } from './history'
import { ChatMessage } from './message-row'
import { PlanPanel, type ConversationPlan } from './plan-panel'
import { SubAgentLiveView, statusLabel, statusVariant } from './sub-agent-panel'
import { isSubAgentActive, subAgentTabs, type SubAgentTab } from './sub-agent-live'
import { toMessageState, useLiveSubAgents } from './chat-session'
import { copyText } from '@/lib/clipboard'
import { durationText, tokenText } from './format'

/** 有子助手在跑时，`run/list` 的轮询间隔（毫秒）；为什么取 4s 见下方 `runsQuery` 的注释 */
const SUB_AGENT_POLL_INTERVAL = 4_000

/** 右栏的 tab（`focus` 与初始 tab 都用它，避免各处写裸字符串） */
export type RightPanelTab = 'system' | 'subagents' | 'plan'

/**
 * 会话页**右栏**：把"这一轮的旁证"集中到一处，按 tab 切换。
 *
 * 三个 tab：
 * 1. **系统指令** —— 本会话实际送进模型的那份提示词快照，用 Markdown 组件渲染（原来挤在页头弹窗里），
 *    可一键复制；
 * 2. **任务** —— 这一会话的**任务清单**（当前计划 + 更早版本折在「变更历史」里）。
 *    完整清单放在这里而不是消息流里：它会随每一轮变长，铺在对话里会把正文切成两半；
 *    消息里只留一张紧凑卡（目标 + 进度 + 跳过来的入口）。数据由会话页用**与消息内同一份**
 *    收集逻辑（`conversationPlanOf` → `collectMessagePlan`）算好传进来，两处不会各说各话；
 * 3. **子 agent 运行** —— 这一会话里每个子助手**各自的完整过程**（推理 / 工具往返 / 正文）。
 *    内容区再分一层 tab（一个子 run 一个 tab），渲染用**主对话同一个 `ChatMessage`**：
 *    同一套映射 + 同一个组件，所以"看起来和主 agent 一样"是结构上的事实，不是照着抄的样式。
 *
 * 两条数据链路（运行中 / 已结束）：
 * - **运行中**：面板自己订阅会话 store 里的实时数据（`onData` 收的 `data-sub-agent*` 块），
 *   tab 立刻就有内容、且**边跑边长** —— 不必等库里的时间线落完，也不新增任何后端接口；
 * - **已结束 / 刷新后**：按需拉该子 run 的完整时间线（`loadWholeTimeline` + 主对话同一套渲染）。
 *
 * 为什么是"右栏"而不是又一个弹窗：子助手的过程要跟主对话**对着看**
 * （主对话里子助手卡片只有结论，细节在这儿），弹窗一挡就看不成了。
 */
export function ConversationRightPanel({
  client,
  conversationId,
  agentKey,
  plan = null,
  defaultTab = 'system',
  focus = null,
}: {
  client: ServerClient
  /** 新会话还没有 id：系统指令 tab 仍可看静态定义，子 agent tab 给空态 */
  conversationId?: string
  agentKey?: string
  /** 这一会话的当前计划（会话页算好；没有任务清单时为 null） */
  plan?: ConversationPlan | null
  /** 首次挂载停在哪个 tab（面板此后受控，由用户与 `focus` 驱动） */
  defaultTab?: RightPanelTab
  /**
   * **切 tab 的请求**（消息里的「查看清单」、子助手活动时的自动展开都用它）。
   *
   * 为什么不直接传 tab 名：`defaultValue` 只在挂载那一刻生效，面板已经开着时再传一次是没用的
   * （用户点了「查看清单」却停在原来的 tab 上）。带 `nonce` 的请求能让**同一次点击**也生效，
   * 而 `nonce` 变化才触发，所以用户的后续手动切换不会被抢回去。
   */
  focus?: { tab: RightPanelTab; nonce: number } | null
}) {
  /**
   * 本次运行中各子助手的实时过程。
   *
   * 面板自己订阅 store（而不是由会话页把数据传下来）：实时增量一窗合并一次，
   * 只有面板这个子树跟着更新，消息列表不受影响。
   */
  const liveSubAgents = useLiveSubAgents()

  // 初始 tab 优先取"这次的切换请求"：请求与"打开面板"是同一次 state 更新，
  // 所以面板首次挂载就能直接落在目标 tab 上，不会先闪一下「系统指令」
  const [tab, setTab] = useState<RightPanelTab>(focus?.tab ?? defaultTab)

  /** 响应切 tab 请求：只有 `nonce` 变化才动手（同一个请求不会反复抢用户的 tab） */
  useEffect(() => {
    if (focus) setTab(focus.tab)
  }, [focus?.nonce])
  /**
   * 运行列表在**面板这一层**取：tab 标签上要显示子助手数量，内容区也要用同一份数据 ——
   * 两处各查一次必然出现"标签说 3 个、内容只有 2 个"的错位。
   *
   * 有子助手在跑时**轮询刷新**：子 run 是起跑那一刻才落库的，一次性查询会出现
   * "实时块里已经有它、库里这份还没有"的窗口（那会影响跑完之后能否切到完整时间线）。
   * 跑完就停（`false`），不给空闲页面留无谓请求。
   *
   * **为什么是 4 秒**：子 run 的起止间隔通常是秒级到分钟级，4s 足够在用户刚看到子助手卡片之后
   * 就把库里的 run 记录对齐（切到完整时间线的前提）；而 `run/list` 只是一页 100 条的索引查询、
   * 且只在有子助手在跑的那段时间发 —— 有感知、又不会在后台空转打库。
   * 不追求更实时：运行中的明细本来就走实时块（消息 parts），这份轮询只负责"把库里的记录对齐"。
   */
  const runsQuery = useQuery({
    queryKey: ['ai', 'runs', conversationId ?? 'none'],
    queryFn: () => loadWholeRuns(client, conversationId as string),
    enabled: Boolean(conversationId),
    refetchInterval: liveSubAgents.some(isSubAgentActive) ? SUB_AGENT_POLL_INTERVAL : false,
  })
  const subRuns = useMemo(
    () => (runsQuery.data ?? []).filter((run) => run.parentRunId !== null),
    [runsQuery.data],
  )
  /** 库里的子 run 与实时数据合流成 tab（谁先有就先用谁的，见 `subAgentTabs`） */
  const tabs = useMemo(() => subAgentTabs(subRuns, liveSubAgents), [subRuns, liveSubAgents])

  /** tab 标签上的进度（`3/5`）：与卡片正文同一份数据算出来，不会出现"标签说 3、内容说 4" */
  const planProgress = useMemo(() => {
    if (!plan) return null
    const tasks = plan.current.plan.tasks
    return { done: tasks.filter((task) => task.status === 'done').length, total: tasks.length }
  }, [plan])

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as RightPanelTab)} className="flex h-full min-h-0 flex-col gap-1.5">
      <TabsList className="w-full">
        <TabsTrigger value="system">
          <ScrollTextIcon className="size-3.5" />
          系统指令
        </TabsTrigger>
        <TabsTrigger value="plan">
          <ListTodoIcon className="size-3.5" />
          任务{planProgress ? `（${planProgress.done}/${planProgress.total}）` : ''}
        </TabsTrigger>
        <TabsTrigger value="subagents">
          <BotIcon className="size-3.5" />
          子 agent{tabs.length > 0 ? `（${tabs.length}）` : ''}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="system" className="flex min-h-0 flex-1 flex-col">
        <SystemPromptPanel client={client} conversationId={conversationId} agentKey={agentKey} />
      </TabsContent>

      <TabsContent value="plan" className="flex min-h-0 flex-1 flex-col">
        <PlanRunsPanel plan={plan} />
      </TabsContent>

      <TabsContent value="subagents" className="flex min-h-0 flex-1 flex-col">
        <SubAgentRunsPanel
          client={client}
          conversationId={conversationId}
          tabs={tabs}
          loading={runsQuery.isLoading && liveSubAgents.length === 0}
          error={runsQuery.isError && liveSubAgents.length === 0 ? runsQuery.error : undefined}
        />
      </TabsContent>
    </Tabs>
  )
}

/**
 * 任务 tab：**这一会话的完整任务清单**（当前计划 + 更早版本折在「变更历史」里）。
 *
 * 数据是会话页算好传进来的（`conversationPlanOf`），**与消息里那张紧凑卡同源** ——
 * 所以"消息说 3/5、这里说 3/5"是结构上的事实，不是两处各算一遍。
 *
 * 为什么要独立成 tab：清单会随每一轮变长（任务 + 备注），铺在消息流里会把正文切成两半；
 * 放这儿可以**边翻对话边对着清单看**，而且不占正文宽度（这正是右栏的用途）。
 * 空态只给一句话：没有计划时不该出现一个"空壳面板"（用户会以为加载失败）。
 */
function PlanRunsPanel({ plan }: { plan: ConversationPlan | null }) {
  if (!plan) {
    return (
      <p className="text-xs text-muted-foreground">
        这一会话还没有任务清单 —— 让它把多步任务列成清单后，这里会显示当前进度与每一项的状态。
      </p>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PlanPanel plan={plan.current.plan} change={plan.current.change} history={plan.history} />
    </div>
  )
}

/**
 * 系统指令 tab：**只读**呈现 + 复制。
 *
 * 数据源与页头的说明完全同源（`POST /agent/instructions`）：
 * 有快照就显示快照（会话真正用过的那份），没有就显示当前 agent 的静态定义，并如实标注来源 ——
 * 不把"定义"冒充成"这个会话当时用的那份"。
 */
function SystemPromptPanel({
  client,
  conversationId,
  agentKey,
}: {
  client: ServerClient
  conversationId?: string
  agentKey?: string
}) {
  const query = useQuery({
    queryKey: ['ai', 'instructions', conversationId ?? 'none', agentKey ?? 'default'],
    queryFn: () =>
      client.agent.instructions({
        ...(conversationId ? { conversationId } : {}),
        ...(agentKey ? { agentKey } : {}),
      }),
  })
  const instructions = query.data?.instructions ?? ''

  const copy = async () => {
    try {
      await copyText(instructions)
      toastSuccess('已复制系统指令')
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {query.data
            ? `${query.data.name} · ${
                query.data.source === 'conversation' ? '本会话快照（渲染后）' : '静态定义（本会话暂无快照）'
              }`
            : '正在加载…'}
        </span>
        <IconText
          icon={<CopyIcon />}
          size="small"
          type="primary"
          text="复制"
          tooltip="复制系统指令全文"
          aria-label="复制系统指令全文"
          disabled={!instructions}
          onClick={copy}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md bg-surface-1 p-2.5">
        {query.isLoading ? (
          <p className="text-xs text-muted-foreground">正在加载系统指令…</p>
        ) : query.isError ? (
          <p className="text-xs text-destructive">
            加载失败：{query.error instanceof Error ? query.error.message : String(query.error)}
          </p>
        ) : (
          <Markdown content={instructions} />
        )}
      </div>
    </div>
  )
}

/** 子 agent tab：外层是「哪个子助手」，里层才是它的过程 */
function SubAgentRunsPanel({
  client,
  conversationId,
  tabs,
  loading,
  error,
}: {
  client: ServerClient
  conversationId?: string
  tabs: SubAgentTab[]
  loading: boolean
  error?: unknown
}) {
  const [activeRunId, setActiveRunId] = useState<string>()

  /**
   * tab 标签：同名子助手出现多次时补 `#序号`（同一个名字跑了两遍，标签一模一样就分不清哪个是哪个）。
   */
  const labels = useMemo(() => {
    const total = new Map<string, number>()
    for (const tab of tabs) total.set(tab.name, (total.get(tab.name) ?? 0) + 1)
    const seen = new Map<string, number>()
    const map = new Map<string, string>()
    for (const tab of tabs) {
      const index = (seen.get(tab.name) ?? 0) + 1
      seen.set(tab.name, index)
      map.set(tab.runId, (total.get(tab.name) ?? 0) > 1 ? `${tab.name} #${index}` : tab.name)
    }
    return map
  }, [tabs])

  if (!conversationId) {
    return (
      <p className="p-1 text-xs text-muted-foreground">
        发出第一条消息之后，这里会列出每个子助手的完整过程。
      </p>
    )
  }
  if (loading) return <p className="p-1 text-xs text-muted-foreground">正在加载运行记录…</p>
  if (error) {
    return (
      <p className="p-1 text-xs text-destructive">
        加载失败：{error instanceof Error ? error.message : String(error)}
      </p>
    )
  }
  if (tabs.length === 0) {
    return (
      <p className="p-1 text-xs text-muted-foreground">
        这一会话还没有子助手运行 —— 主 agent 自己干完了。
      </p>
    )
  }

  const current = tabs.find((tab) => tab.runId === activeRunId) ?? tabs[0]!

  return (
    <Tabs
      value={current.runId}
      onValueChange={(value) => setActiveRunId(String(value))}
      className="flex min-h-0 flex-1 flex-col gap-1.5"
    >
      <TabsList className="w-full justify-start overflow-x-auto">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.runId} value={tab.runId} className="flex-none">
            {/* 活动态与底部运行指示同一套观感：转圈 + 主色（一眼看出哪个子助手还在跑） */}
            {tab.active ? (
              <LoaderCircleIcon className="size-3.5 animate-spin text-primary motion-reduce:animate-none" />
            ) : (
              <BotIcon className="size-3.5" />
            )}
            {labels.get(tab.runId)}
          </TabsTrigger>
        ))}
      </TabsList>
      {/* 只挂当前这一个 tab 的内容：多个子 run 一起查时间线是白花的请求 */}
      <TabsContent value={current.runId} className="min-h-0 flex-1 overflow-auto">
        <SubAgentTabContent client={client} conversationId={conversationId} tab={current} />
      </TabsContent>
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
  conversationId,
  run,
}: {
  client: ServerClient
  conversationId: string
  run: AgentRunModel
}) {
  const query = useQuery({
    queryKey: ['ai', 'timeline', conversationId, 'run', run.id],
    queryFn: async () => {
      const items = await loadWholeTimeline(client, conversationId, run.id)
      // 只映射这一个子 run：主 run 的消息不该出现在子助手的 tab 里
      return toUIMessages(items, [run], { onlyRunIds: [run.id] })
    },
  })
  const messages = query.data ?? []
  const totalTokens = run.usage?.totalTokens

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Badge variant={statusVariant(run.status)}>
          {statusLabel[run.status] ?? run.status}
        </Badge>
        <span>
          {run.stepCount} 步 / {run.toolCallCount} 次工具 · {durationText(run.durationMs)}
          {typeof totalTokens === 'number' ? ` · ${tokenText(totalTokens)} token` : ''}
        </span>
      </div>
      {run.errorMessage ? (
        <p className="text-xs text-destructive">{run.errorMessage}</p>
      ) : null}
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
