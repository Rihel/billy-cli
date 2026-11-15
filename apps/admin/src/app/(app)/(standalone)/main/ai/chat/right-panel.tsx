'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UIMessage } from 'ai'
import type { AgentFileNode, AiSkillModel } from '@repo/shared'
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
  ListTodoIcon,
  ScrollTextIcon,
  SparklesIcon,
} from 'lucide-react'
import type { ServerClient } from './data'
import { PlanPanel, type ConversationPlan } from './plan-panel'
import { copyText } from '@/lib/clipboard'
import { activatedSkillsOf } from './skill-activity'
import { SkillPreviewDialog } from './skill-preview-dialog'
import { FilesPanel } from './files-panel'

/** 右栏的 tab（`focus` 与初始 tab 都用它，避免各处写裸字符串） */
export type RightPanelTab = 'system' | 'skills' | 'plan' | 'files'

/**
 * 会话页**右栏**：把"这一轮的旁证"集中到一处，按 tab 切换。
 *
 * 四个 tab（子 agent 的完整过程**不在这里**：它跟主会话是**平级**的两条会话，
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
 * 4. **文件** —— 会话文件树（用户上传 + AI 提交）与工作区两个视图。
 *
 * 为什么是"右栏"而不是又一个弹窗：这些内容要跟主对话**对着看**
 * （一边看清单 / 提示词，一边看它怎么答），弹窗一挡就看不成了。
 */
export function ConversationRightPanel({
  client,
  conversationId,
  agentKey,
  messages = [],
  plan = null,
  files = [],
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

  /** tab 标签上的进度（`3/5`）：与卡片正文同一份数据算出来，不会出现"标签说 3、内容说 4" */
  const planProgress = useMemo(() => {
    if (!plan) return null
    const tasks = plan.current.plan.tasks
    return { done: tasks.filter((task) => task.status === 'done').length, total: tasks.length }
  }, [plan])

  /** 本会话激活过的技能（消息 parts 派生；调用次数降序） */
  const activatedSkills = useMemo(() => activatedSkillsOf(messages), [messages])

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as RightPanelTab)}
      // 面板**白底**（页面底是中灰，白底把右栏从主区里分出来）+ 四周内边距：
      // 内容不再贴着面板边缘，tab 条的胶囊也有呼吸空间
      className="flex h-full min-h-0 flex-col gap-1.5 bg-card p-3"
    >
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
      </TabsList>

      <TabsContent value="system" className="flex min-h-0 flex-1 flex-col">
        <SystemPromptPanel client={client} conversationId={conversationId} agentKey={agentKey} />
      </TabsContent>

      <TabsContent value="skills" className="flex min-h-0 flex-1 flex-col">
        <ActivatedSkillsPanel
          client={client}
          conversationId={conversationId}
          activated={activatedSkills}
        />
      </TabsContent>

      <TabsContent value="plan" className="flex min-h-0 flex-1 flex-col">
        <PlanRunsPanel plan={plan} />
      </TabsContent>

      <TabsContent value="files" className="flex min-h-0 flex-1 flex-col">
        <FilesPanel client={client} conversationId={conversationId} files={files} />
      </TabsContent>
    </Tabs>
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
                query.data.source === 'conversation'
                  ? '本会话快照（渲染后）'
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
        ) : (
          <Markdown content={instructions} />
        )}
      </div>
    </div>
  )
}
