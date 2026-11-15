'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UIMessage } from 'ai'
import type { AgentFileNode, AgentRunDetailModel, AiSkillModel } from '@repo/shared'
import {
  Badge,
  Button,
  IconText,
  Markdown,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toastError,
  toastSuccess,
} from '@repo/ui'
import {
  CopyIcon,
  EyeIcon,
  FolderIcon,
  FolderTreeIcon,
  ListTodoIcon,
  ScrollTextIcon,
  SparklesIcon,
} from 'lucide-react'
import type { ServerClient } from './data'
import { loadWholeTimeline } from './data'
import { conversationPlanOf, PlanPanel, type ConversationPlan } from './plan-panel'
import { copyText } from '@/lib/clipboard'
import { activatedSkillsOf } from './skill-activity'
import { SkillPreviewDialog } from './skill-preview-dialog'
import { FilesPanel } from './files-panel'
import { toUIMessages } from './history'
import { subRunName } from './sub-agent-live'
import { statusLabel } from './sub-agent-panel'

/** 右栏的 tab（`focus` 与初始 tab 都用它，避免各处写裸字符串） */
export type RightPanelTab = 'system' | 'skills' | 'plan' | 'files' | 'workspace'

/**
 * 会话页**右栏**：把"这一轮的旁证"集中到一处，按 tab 切换。
 *
 * 五个 tab（子 agent 的完整过程**不在这里**：它跟主会话是**平级**的两条会话，
 * 现在放在主区顶部的 tab 条里，见 `session-tabs.tsx`）：
 * 1. **系统指令** —— 本会话实际送进模型的那份提示词快照，用 Markdown 组件渲染（原来挤在页头弹窗里），
 *    可一键复制；
 * 2. **技能** —— 本会话**实际激活过**的技能（运行时 `skill` 工具的调用，按名字聚合）。
 *    模型是按 description 自己决定调不调的，所以这里不列"可用技能"那 20 多个；
 *    想确认"它到底读没读我那个技能"，看这个 tab；
 * 3. **任务** —— 这一会话的**任务清单**（当前计划 + 更早版本折在「变更历史」里）。
 *    完整清单放在这里而不是消息流里：它会随每一轮变长，铺在对话里会把正文切成两半；
 *    消息里只留一张紧凑卡（目标 + 进度 + 跳过来的入口）。数据由会话页用**与消息内同一份**
 *    收集逻辑（`conversationPlanOf` → `collectMessagePlan`）算好传进来，两处不会各说各话；
 * 4. **文件** —— 会话文件（用户上传 + AI 提交，OSS 持久）；
 * 5. **工作区** —— 会话工作区里的实际文件（本地盘，AI 写文件的地方，换 Pod 可能没了）。
 *
 * 为什么「文件」与「工作区」是**两个平级 tab** 而不是一个 tab 里分段切换：它们是两个不同的东西
 * （来源、持久性、清理时机都不同），分段切换读起来像"一个东西的两种看法"，平级则像"两个入口"。
 * 两者的内容都**一次拿全量**、前端自己拼树（见 `files-panel.tsx`）。
 *
 * 为什么是"右栏"而不是又一个弹窗：这些内容要跟主对话**对着看**
 * （一边看清单 / 提示词，一边看它怎么答），弹窗一挡就看不成了。
 *
 * ## 作用域：跟着主区顶部的 tab 走（2026-11-15 起）
 *
 * 主区切到某个子 agent 的 tab（`activeRunId`）时，右栏**整体换成这个子助手的事实** ——
 * 否则会变成"页头/主区是子助手、面板还在说父会话"的两套主语：
 * - 系统指令：它**被要求**的那份提示词（主 agent 现写 + 运行时追加的能力边界，见
 *   `agent-runner.ts` 落的子会话快照）。**注意**：这是"我们交给运行时的完整指令"，
 *   不是模型最终收到的 system —— Mastra 在请求侧还会追加 `<available_skills>` 技能目录段
 *   （2026-11-15 实测，主会话同样如此），那一段不进快照；
 * - 技能：它这一轮**实际激活过**的技能（从它自己的时间线派生）；
 * - 任务：主 agent 交给它的**任务目标**（`request_snapshot.task`）+ 它自己的清单
 *   （plan 工具对子 agent 开放、清单按会话隔离，落在子 run 的时间线里）；
 * - 文件：仍是**共享工作区**（子助手写的就是父会话的文件树），不跟着切，面板上注明这一点。
 *
 * 切回主会话即恢复父会话的信息；两边的取数逻辑是同一套，只是数据源不同。
 */
export function ConversationRightPanel({
  client,
  conversationId,
  agentKey,
  messages = [],
  plan = null,
  files = [],
  activeRunId = null,
  defaultTab = 'system',
  focus = null,
}: {
  client: ServerClient
  /** 新会话还没有 id：系统指令 tab 仍可看静态定义 */
  conversationId?: string
  agentKey?: string
  /** 会话消息（`useChat` 那份）：技能 tab 从 parts 里提取"激活过什么"，实时更新、不额外拉时间线 */
  messages?: UIMessage[]
  /** 这一会话的当前计划（会话页算好；没有任务清单时为 null） */
  plan?: ConversationPlan | null
  /** 会话文件树（`conversation/detail` 的 aiFiles；用户上传 + AI 提交） */
  files?: AgentFileNode[]
  /**
   * 主区当前选中的**子 run id**（`null` = 主会话）：给了就把右栏切到这个子助手的旁证。
   *
   * 只传 id 不传对象：右栏自己按 id 查 `run/detail`（React Query 缓存，切来切回不重复打接口），
   * 免得把运行列表 / 实时块接到这一层（那会让右栏跟着每一帧增量重渲染）。
   */
  activeRunId?: string | null
  /** 首次挂载停在哪个 tab（面板此后受控，由用户与 `focus` 驱动） */
  defaultTab?: RightPanelTab
  /**
   * **切 tab 的请求**（消息里的「查看清单」、页头按钮等都用它）。
   *
   * 为什么不直接传 tab 名：`defaultValue` 只在挂载那一刻生效，面板已经开着时再传一次是没用的
   * （用户点了「查看清单」却停在原来的 tab 上）。带 `nonce` 的请求能让**同一次点击**也生效，
   * 而 `nonce` 变化才触发，所以用户的后续手动切换不会被抢回去。
   */
  focus?: { tab: RightPanelTab; nonce: number } | null
}) {
  // 初始 tab 优先取"这次的切换请求"：请求与"打开面板"是同一次 state 更新，
  // 所以面板首次挂载就能直接落在目标 tab 上，不会先闪一下「系统指令」
  const [tab, setTab] = useState<RightPanelTab>(focus?.tab ?? defaultTab)

  /** 响应切 tab 请求：只有 `nonce` 变化才动手（同一个请求不会反复抢用户的 tab） */
  useEffect(() => {
    if (focus) setTab(focus.tab)
    // focus 每次渲染都是新对象；只在 nonce 变化时应用一次切 tab 请求，避免反复抢用户手动切换
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce])

  /** 子助手作用域：主区切到子 tab 时，右栏的取数全部换成这个子 run（null = 主会话） */
  const scope = useSubAgentScope(client, activeRunId)
  const scoped = activeRunId !== null

  /** 当前作用域的消息：技能 tab 从它派生（子助手用它自己的时间线，主会话用 `useChat` 那份） */
  const scopedMessages = scoped ? scope.messages : messages
  /** 当前作用域的计划：子 tab 用它自己的清单，主会话用会话页算好的那份 */
  const scopedPlan = scoped ? scope.plan : plan

  /** tab 标签上的进度（`3/5`）：与卡片正文同一份数据算出来，不会出现"标签说 3、内容说 4" */
  const planProgress = useMemo(() => {
    if (!scopedPlan) return null
    const tasks = scopedPlan.current.plan.tasks
    return { done: tasks.filter((task) => task.status === 'done').length, total: tasks.length }
  }, [scopedPlan])

  /** 当前作用域激活过的技能（消息 parts 派生；调用次数降序） */
  const activatedSkills = useMemo(() => activatedSkillsOf(scopedMessages), [scopedMessages])

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as RightPanelTab)}
      // 面板**白底**（页面底是中灰，白底把右栏从主区里分出来）+ 四周内边距：
      // 内容不再贴着面板边缘，tab 条的胶囊也有呼吸空间
      className="flex h-full min-h-0 flex-col gap-1.5 bg-card p-3"
    >
      {/* 作用域提示：不写清楚，用户会以为右栏还是"这个会话"的信息 */}
      {scoped ? (
        <p className="shrink-0 rounded-md bg-surface-2 px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">
          以下信息属于子助手{' '}
          <span className="font-medium text-foreground">{scope.name || '…'}</span>
          {scope.status && statusLabel[scope.status] ? `（${statusLabel[scope.status]}）` : ''} ·
          切回「主会话」看本会话的信息
        </p>
      ) : null}

      {/* overflow-x-auto 会把另一轴也算成 auto：横向滚动条吃掉 8px 高度后，32px 的标签条
          立刻纵向溢出、长出竖直滚动条。这里显式锁死纵向 + 不画滚动条（标签条不需要） */}
      <TabsList className="w-full justify-start overflow-x-auto overflow-y-hidden scrollbar-none pb-0.5">
        <TabsTrigger value="system" className="shrink-0">
          <ScrollTextIcon className="size-3.5" />
          系统指令
        </TabsTrigger>
        <TabsTrigger value="skills" className="shrink-0">
          <SparklesIcon className="size-3.5" />
          技能{activatedSkills.length > 0 ? `（${activatedSkills.length}）` : ''}
        </TabsTrigger>
        <TabsTrigger value="plan" className="shrink-0">
          <ListTodoIcon className="size-3.5" />
          任务{planProgress ? `（${planProgress.done}/${planProgress.total}）` : ''}
        </TabsTrigger>
        <TabsTrigger value="files" className="shrink-0">
          <FolderIcon className="size-3.5" />
          文件
        </TabsTrigger>
        <TabsTrigger value="workspace" className="shrink-0">
          <FolderTreeIcon className="size-3.5" />
          工作区
        </TabsTrigger>
      </TabsList>

      <TabsContent value="system" className="flex min-h-0 flex-1 flex-col">
        {scoped ? (
          <SubAgentSystemPrompt client={client} scope={scope} />
        ) : (
          <SystemPromptPanel client={client} conversationId={conversationId} agentKey={agentKey} />
        )}
      </TabsContent>

      <TabsContent value="skills" className="flex min-h-0 flex-1 flex-col">
        {scoped && scope.loading ? (
          <ScopeLoading />
        ) : scoped && scope.error ? (
          <ScopeError error={scope.error} />
        ) : (
          <ActivatedSkillsPanel
            client={client}
            conversationId={scoped ? (scope.conversationId ?? undefined) : conversationId}
            activated={activatedSkills}
          />
        )}
      </TabsContent>

      <TabsContent value="plan" className="flex min-h-0 flex-1 flex-col">
        {scoped ? <SubAgentPlanPanel scope={scope} /> : <PlanRunsPanel plan={plan} />}
      </TabsContent>

      <TabsContent value="files" className="flex min-h-0 flex-1 flex-col">
        <FilesPanel client={client} conversationId={conversationId} files={files} view="session" />
        {scoped ? <SharedWorkspaceNote /> : null}
      </TabsContent>

      <TabsContent value="workspace" className="flex min-h-0 flex-1 flex-col">
        <FilesPanel
          client={client}
          conversationId={conversationId}
          files={files}
          view="workspace"
        />
        {scoped ? <SharedWorkspaceNote /> : null}
      </TabsContent>
    </Tabs>
  )
}

/** 子助手 tab 下两个文件 tab 共用的一句说明（写清楚主语：列的是本会话的文件树） */
function SharedWorkspaceNote() {
  return (
    <p className="shrink-0 pt-2 text-[11px] leading-4 text-muted-foreground">
      子助手与你共用同一个工作区，这里列的是本会话的文件树。
    </p>
  )
}

/** 子助手作用域的一整包数据（右栏四个 tab 都从它取，避免各查一遍） */
interface SubAgentScope {
  /** `run/detail` 还在路上（还没拿到 run，或 run 到了但时间线还没到） */
  loading: boolean
  /** 子会话 id：系统指令 / 技能 tab 按它取数 */
  conversationId: string | null
  /** 子助手名字（`sub:<名字>` 的后半段） */
  name: string
  status: string | null
  /** 主 agent 交给它的任务目标（`request_snapshot.task`） */
  task: string | null
  /** 子 run 的消息（与主区 `SubRunView` **同一个缓存键**，不重复请求） */
  messages: UIMessage[]
  plan: ConversationPlan | null
  /** 旧子 run 的"主 agent 原稿"（不含运行时追加的能力边界段），只在没有快照时用 */
  promptDraft: string | null
  error: string | null
}

/**
 * 按子 run id 取右栏要用的那一份数据。
 *
 * 两跳查询（都不新增接口）：
 * 1. `run/detail`：拿 `conversationId` / `agentKey` / 任务目标 / 原稿；
 * 2. 子 run 的时间线：与主区 `SubRunView` **完全同一个 queryKey 与 queryFn**，
 *    所以切 tab 时两边共享同一份缓存 —— 列表只打一次、渲染两份（一份过程、一份清单）。
 *
 * **运行中轮询时间线**（3s）：清单是 `plan` 事件（每次 `plan-*` 工具调用一条），
 * 它落在**子会话**的时间线里，不经过父会话那条流 —— 不轮询就看不到"边做边变"的进度。
 * 一个子 run 的时间线只有它自己的事件（服务端已按 runId 过滤），代价可控；跑完即停。
 */
function useSubAgentScope(client: ServerClient, activeRunId: string | null): SubAgentScope {
  const runQuery = useQuery({
    queryKey: ['ai', 'run', activeRunId ?? 'none'],
    queryFn: () => client.agent.run.detail({ runId: activeRunId as string }),
    enabled: Boolean(activeRunId),
    // 跑着就每 4s 刷新一次状态（与「运行列表」同一节奏）：终态后停，且时间线轮询随之停
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status && ['pending', 'running', 'suspended'].includes(String(status)) ? 4_000 : false
    },
  })
  const run = runQuery.data
  /** 子 run 还在跑：清单 / 用量都可能变（终态后停止轮询） */
  const runActive =
    run !== undefined && ['pending', 'running', 'suspended'].includes(String(run.status))

  const timelineQuery = useQuery({
    queryKey: ['ai', 'timeline', run?.conversationId ?? 'none', 'run', run?.id ?? 'none'],
    queryFn: async () => {
      const items = await loadWholeTimeline(client, run!.conversationId, run!.id)
      return toUIMessages(items, [run as AgentRunDetailModel], { onlyRunIds: [run!.id] })
    },
    enabled: Boolean(run),
    refetchInterval: runActive ? 3_000 : false,
  })

  const messages = useMemo(() => timelineQuery.data ?? [], [timelineQuery.data])
  const plan = useMemo(() => conversationPlanOf(messages), [messages])

  return useMemo(() => {
    const snapshot = run?.requestSnapshot as Record<string, unknown> | null | undefined
    const task = typeof snapshot?.task === 'string' ? snapshot.task : null
    const promptDraft = typeof snapshot?.systemPrompt === 'string' ? snapshot.systemPrompt : null
    return {
      loading:
        Boolean(activeRunId) && (runQuery.isLoading || (Boolean(run) && timelineQuery.isLoading)),
      conversationId: run?.conversationId ?? null,
      name: run ? subRunName(run.agentKey) : '',
      status: run?.status ?? null,
      task,
      messages,
      plan,
      promptDraft,
      error:
        runQuery.error instanceof Error
          ? runQuery.error.message
          : timelineQuery.error instanceof Error
            ? timelineQuery.error.message
            : null,
    }
  }, [
    run,
    messages,
    plan,
    runQuery.isLoading,
    runQuery.error,
    timelineQuery.isLoading,
    timelineQuery.error,
    activeRunId,
  ])
}

/** 子助手数据还在路上时的统一占位（别让面板显示成"这个会话没有…"） */
function ScopeLoading() {
  return <p className="text-xs text-muted-foreground">正在准备子助手信息…</p>
}

/** 子助手数据取不到时如实报错（不要静默退化成空态：空态会被读成"它没有这些信息"） */
function ScopeError({ error }: { error: string }) {
  return <p className="text-xs text-destructive">加载失败：{error}</p>
}

/**
 * 子助手的**系统指令** tab：主 agent 现写 + 运行时追加的能力边界（最终文本）。
 *
 * 数据仍走 `POST /agent/instructions`（传**子会话 id**）：主会话与子会话的快照存在同一张时间线表里，
 * 服务端已经按"先快照、后目录"的次序取数 —— 前端不需要知道子助手的 `sub:<名字>` 不在 agent 目录里。
 */
function SubAgentSystemPrompt({ client, scope }: { client: ServerClient; scope: SubAgentScope }) {
  if (scope.loading) return <ScopeLoading />
  if (scope.error) return <ScopeError error={scope.error} />
  return (
    <SystemPromptPanel
      client={client}
      conversationId={scope.conversationId ?? undefined}
      draft={scope.promptDraft}
    />
  )
}

/**
 * 子助手的**任务** tab：任务目标 + 它自己的清单。
 *
 * 「任务目标」放这里而不是塞进技能/文件：它就是"这一轮要它做什么"，和清单是同一件事的两种粒度
 * （目标一句话、清单是它的拆解）。运行中清单可能还没建，先说清"它还没建清单"。
 */
function SubAgentPlanPanel({ scope }: { scope: SubAgentScope }) {
  if (scope.loading) return <ScopeLoading />
  if (scope.error) return <ScopeError error={scope.error} />
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
      <section className="shrink-0 rounded-lg border border-border/60 bg-surface-2 px-2.5 py-2">
        <h4 className="text-[11px] font-medium text-muted-foreground">任务目标</h4>
        <p className="mt-1 whitespace-pre-wrap text-xs leading-5">
          {scope.task ?? '（没有记录任务目标）'}
        </p>
      </section>
      {scope.plan ? (
        <PlanPanel
          plan={scope.plan.current.plan}
          change={scope.plan.current.change}
          history={scope.plan.history}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          这个子助手还没有建任务清单 —— 它在过程中调 `plan-create` 后，这里会显示它自己的进度。
        </p>
      )}
    </div>
  )
}

/**
 * 技能 tab：本会话**实际激活过**的技能。
 *
 * 数据来自消息 parts（`skill` 工具的入参），不是另外拉一遍时间线 —— 实时调用一出现，
 * 面板就跟着更新；历史会话也由同一份消息还原出来，不会出现"刷新后列表空了"。
 *
 * 只列激活过的，不列"可用技能"：可用清单有 20 多个（含外部目录），铺在这里是噪音；
 * 用户真正的问题是"它到底读没读我那个技能"。
 *
 * 能关联到库里就补一句 description 与「查看」入口；关联不到（外部 `~/.agents/skills` 的同名技能）
 * 就明确标「库外」—— 不假装它也是我们管理的资产。
 */
function ActivatedSkillsPanel({
  client,
  conversationId,
  activated,
}: {
  client: ServerClient
  conversationId?: string
  activated: readonly { name: string; calls: number }[]
}) {
  const [viewing, setViewing] = useState<string | null>(null)
  const catalogQuery = useQuery({
    queryKey: ['ai', 'skill-catalog'],
    queryFn: () => client.aiSkill.list({ page: 1, size: 100 }),
    // 没有激活技能就不查；面板空态不需要目录
    enabled: activated.length > 0,
  })

  const byKey = useMemo(() => {
    const map = new Map<string, AiSkillModel>()
    for (const skill of catalogQuery.data?.items ?? []) map.set(skill.skillKey, skill)
    return map
  }, [catalogQuery.data])

  if (!conversationId) {
    return (
      <p className="text-xs text-muted-foreground">
        新会话还没有跑过 —— 模型激活技能后，这里会显示它读的是哪个技能。
      </p>
    )
  }

  if (activated.length === 0) {
    return (
      <div className="flex flex-col gap-2 text-xs text-muted-foreground">
        <p>这一会话还没有激活任何技能。</p>
        <p>
          模型按每个技能的 description 自己决定调不调用；想指定就直接说「用
          &lt;技能名&gt;」或「用暴躁老哥的语气」。
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
      <p className="text-[11px] leading-4 text-muted-foreground">
        模型按 description 命中后调用了 `skill`；下面是本会话实际激活过的技能。
      </p>
      {activated.map((skill) => {
        const meta = byKey.get(skill.name)
        return (
          <div
            key={skill.name}
            className="flex flex-col gap-1 rounded-lg border border-border/60 bg-surface-1/40 px-3 py-2"
          >
            <div className="flex items-center gap-1.5">
              <SparklesIcon className="size-3.5 shrink-0 text-brand" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
                {skill.name}
              </span>
              <Badge variant="secondary">{skill.calls} 次</Badge>
              {meta && !meta.enabled ? <Badge variant="outline">已停用</Badge> : null}
              {!meta ? <Badge variant="outline">库外</Badge> : null}
            </div>
            <p className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
              {meta?.description ?? '不在技能库中（来自外部技能目录，本页面无法管理）'}
            </p>
            {meta ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto w-fit gap-1 px-0 text-[11px]"
                onClick={() => setViewing(skill.name)}
              >
                查看技能
                <EyeIcon className="size-3" />
              </Button>
            ) : null}
          </div>
        )
      })}

      <SkillPreviewDialog
        open={viewing !== null}
        skillKey={viewing ?? ''}
        onOpenChange={(next) => {
          if (!next) setViewing(null)
        }}
      />
    </div>
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
 *
 * `draft`（子助手专用）：`source='unrecorded'` 时服务端**没有**快照可回 —— 那说明这次子 run
 * 跑在"子会话落快照"之前。此时把 `request_snapshot.systemPrompt`（主 agent 原稿）摆出来并注明
 * **不含运行时追加的能力边界**，比只显示一句"没有记录"有用，也不冒充最终那份。
 */
function SystemPromptPanel({
  client,
  conversationId,
  agentKey,
  draft = null,
}: {
  client: ServerClient
  conversationId?: string
  agentKey?: string
  draft?: string | null
}) {
  const query = useQuery({
    queryKey: ['ai', 'instructions', conversationId ?? 'none', agentKey ?? 'default'],
    queryFn: () =>
      client.agent.instructions({
        ...(conversationId ? { conversationId } : {}),
        ...(agentKey ? { agentKey } : {}),
      }),
  })
  const unrecorded = query.data?.source === 'unrecorded'
  const instructions = unrecorded ? (draft ?? '') : (query.data?.instructions ?? '')

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
                query.data.source === 'conversation'
                  ? '本会话快照（渲染后）'
                  : query.data.source === 'unrecorded'
                    ? '未记录快照 · 主 agent 原稿'
                    : '静态定义（本会话暂无快照）'
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
      <div className="min-h-0 flex-1 overflow-auto rounded-md bg-surface-2 p-2.5">
        {query.isLoading ? (
          <p className="text-xs text-muted-foreground">正在加载系统指令…</p>
        ) : query.isError ? (
          <p className="text-xs text-destructive">
            加载失败：{query.error instanceof Error ? query.error.message : String(query.error)}
          </p>
        ) : unrecorded && !draft ? (
          <p className="text-xs text-muted-foreground">
            这次运行没有留下系统指令快照（早于 2026-11-15 的子助手），主 agent 原稿也没有入库。
          </p>
        ) : (
          <>
            {unrecorded ? (
              <p className="mb-2 rounded-md border border-border/60 px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">
                下面是主 agent 当初写的<b>原稿</b>，不含运行时追加的「能力与边界」段 ——
                它是那次交给子助手的指令的前半部分。
              </p>
            ) : null}
            <Markdown content={instructions} />
          </>
        )}
      </div>
    </div>
  )
}
