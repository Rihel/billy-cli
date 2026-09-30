'use client'

import { useMemo, useState } from 'react'
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
import { BotIcon, CopyIcon, ScrollTextIcon } from 'lucide-react'
import { loadWholeRuns, loadWholeTimeline, type ServerClient } from './data'
import { toUIMessages } from './history'
import { MessageRow } from './message-row'
import { statusLabel, statusVariant } from './sub-agent-panel'
import { copyText } from './clipboard'
import { durationText, tokenText } from './format'

/**
 * 会话页**右栏**：把"这一轮的旁证"集中到一处，按 tab 切换。
 *
 * 两个 tab：
 * 1. **系统指令** —— 本会话实际送进模型的那份提示词快照，用 Markdown 组件渲染（原来挤在页头弹窗里），
 *    可一键复制；
 * 2. **子 agent 运行** —— 这一会话里每个子助手**各自的完整过程**（推理 / 工具往返 / 正文）。
 *    内容区再分一层 tab（一个子 run 一个 tab），渲染用**主对话同一个 `MessageRow`**：
 *    同一套映射 + 同一个组件，所以"看起来和主 agent 一样"是结构上的事实，不是照着抄的样式。
 *
 * 为什么是"右栏"而不是又一个弹窗：子助手的过程要跟主对话**对着看**
 * （主对话里子助手卡片只有结论，细节在这儿），弹窗一挡就看不成了。
 */
export function ConversationRightPanel({
  client,
  conversationId,
  agentKey,
}: {
  client: ServerClient
  /** 新会话还没有 id：系统指令 tab 仍可看静态定义，子 agent tab 给空态 */
  conversationId?: string
  agentKey?: string
}) {
  /**
   * 运行列表在**面板这一层**取：tab 标签上要显示子助手数量，内容区也要用同一份数据 ——
   * 两处各查一次必然出现"标签说 3 个、内容只有 2 个"的错位。
   */
  const runsQuery = useQuery({
    queryKey: ['ai', 'runs', conversationId ?? 'none'],
    queryFn: () => loadWholeRuns(client, conversationId as string),
    enabled: Boolean(conversationId),
  })
  const subRuns = useMemo(
    () => (runsQuery.data ?? []).filter((run) => run.parentRunId !== null),
    [runsQuery.data],
  )

  return (
    <Tabs defaultValue="system" className="flex h-full min-h-0 flex-col gap-2">
      <TabsList className="w-full">
        <TabsTrigger value="system">
          <ScrollTextIcon className="size-3.5" />
          系统指令
        </TabsTrigger>
        <TabsTrigger value="subagents">
          <BotIcon className="size-3.5" />
          子 agent{subRuns.length > 0 ? `（${subRuns.length}）` : ''}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="system" className="flex min-h-0 flex-1 flex-col">
        <SystemPromptPanel client={client} conversationId={conversationId} agentKey={agentKey} />
      </TabsContent>

      <TabsContent value="subagents" className="flex min-h-0 flex-1 flex-col">
        <SubAgentRunsPanel
          client={client}
          conversationId={conversationId}
          runs={subRuns}
          loading={runsQuery.isLoading}
          error={runsQuery.isError ? runsQuery.error : undefined}
        />
      </TabsContent>
    </Tabs>
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
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border/60 bg-muted/20 p-3">
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

/** 子助手名字：run 的 `agentKey` 就是 `sub:<名字>`（服务端给子 run 的命名口径） */
const runName = (run: AgentRunModel): string => run.agentKey.replace(/^sub:/, '') || '子助手'

/** 子 agent tab：外层是「哪个子助手」，里层才是它的过程 */
function SubAgentRunsPanel({
  client,
  conversationId,
  runs,
  loading,
  error,
}: {
  client: ServerClient
  conversationId?: string
  runs: AgentRunModel[]
  loading: boolean
  error?: unknown
}) {
  const [activeRunId, setActiveRunId] = useState<string>()

  /**
   * tab 标签：同名子助手出现多次时补 `#序号`（同一个名字跑了两遍，标签一模一样就分不清哪个是哪个）。
   */
  const labels = useMemo(() => {
    const total = new Map<string, number>()
    for (const run of runs) total.set(runName(run), (total.get(runName(run)) ?? 0) + 1)
    const seen = new Map<string, number>()
    const map = new Map<string, string>()
    for (const run of runs) {
      const base = runName(run)
      const index = (seen.get(base) ?? 0) + 1
      seen.set(base, index)
      map.set(run.id, (total.get(base) ?? 0) > 1 ? `${base} #${index}` : base)
    }
    return map
  }, [runs])

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
  if (runs.length === 0) {
    return (
      <p className="p-1 text-xs text-muted-foreground">
        这一会话还没有子助手运行 —— 主 agent 自己干完了。
      </p>
    )
  }

  const current = runs.find((run) => run.id === activeRunId) ?? runs[0]!

  return (
    <Tabs
      value={current.id}
      onValueChange={(value) => setActiveRunId(String(value))}
      className="flex min-h-0 flex-1 flex-col gap-2"
    >
      <TabsList className="w-full justify-start overflow-x-auto">
        {runs.map((run) => (
          <TabsTrigger key={run.id} value={run.id} className="flex-none">
            <BotIcon className="size-3.5" />
            {labels.get(run.id)}
          </TabsTrigger>
        ))}
      </TabsList>
      {/* 只挂当前这一个 tab 的内容：多个子 run 一起查时间线是白花的请求 */}
      <TabsContent value={current.id} className="min-h-0 flex-1 overflow-auto">
        <SubRunView client={client} conversationId={conversationId} run={current} />
      </TabsContent>
    </Tabs>
  )
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
          <MessageRow
            key={message.id}
            message={message}
            streaming={false}
            client={client}
            conversationId={conversationId}
          />
        ))
      )}
    </div>
  )
}
