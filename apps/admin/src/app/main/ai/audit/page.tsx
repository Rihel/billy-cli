'use client'

import { useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  Badge,
  Button,
  DataTable,
  DictTag,
  DisplayValue,
  Markdown,
  RefreshButton,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Switch,
  cn,
  Label,
} from '@repo/ui'
import type { DataTableColumnDef } from '@repo/ui'
import {
  ConversationStatus,
  RunStatus,
  TimelineKind,
  TimelineRole,
} from '@repo/shared'
import type {
  AgentConversationModel,
  AgentTimelineItemModel,
} from '@repo/shared'
import { useServerClient } from '@/lib/server-client'

/**
 * AI 审计与复盘（`/main/ai/audit`）。
 *
 * 三层视角，从粗到细：
 * 1. **会话**：谁在什么时候聊了什么（含软删，审计要能看到"被删过的会话"）；
 * 2. **运行**：一次问答一行（**含子 agent**，靠 `parentRunId` / `depth` 分出父子树），
 *    状态、步数、工具次数、耗时、消耗、失败环节；
 * 3. **时间线 + 输入快照**：这件事的每一个 part（消息 / 推理 / 工具入参出参 / 步骤 / 计划 / 摘要 / 错误）
 *    与"当时送给模型的输入"。
 *
 * 硬约束（与后端一致）：运行与时间线**只读**，没有删除入口 —— 它们是审计证据；
 * 只有会话能软删，且删除动作本身会记进时间线。
 *
 * 交互：会话列表留在页面上，点「查看运行」在**右侧 50% 抽屉**里看这一会话的运行 / 快照 / 时间线。
 * 抽屉里独立滚动，页面不会因为一次复盘被拉成很长的一列。
 */
const PAGE_SIZE = 10
/**
 * 后端 `BasePaginateSchema` 的硬上限是 100（再多会被 400 拒绝）。
 * 审计要尽量一次看全，所以按上限取，取不完再「加载更多」。
 */
const STREAM_PAGE_SIZE = 100

const formatDuration = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`

/** 消耗：只显示确实上报了的字段（`null` = provider 没给，不是 0） */
const tokenSummary = (usage: Record<string, unknown> | null): string => {
  if (!usage) return '—'
  const total = usage.totalTokens
  const input = usage.inputTokens
  const output = usage.outputTokens
  if (total === null && input === null && output === null) return '—'
  return `${total ?? '-'}（入 ${input ?? '-'} / 出 ${output ?? '-'}）`
}

/** 分页游标：后端返回 `page / size / total`，还有下一页就再要一页 */
const nextPageParam = (last: { page: number; size: number; total: number }): number | undefined =>
  last.page * last.size < last.total ? last.page + 1 : undefined

export default function AiAuditPage() {
  const client = useServerClient()
  const [page, setPage] = useState(1)
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [conversation, setConversation] = useState<AgentConversationModel>()
  const [runId, setRunId] = useState<string>()
  const [drawerOpen, setDrawerOpen] = useState(false)

  const conversationsQuery = useQuery({
    queryKey: ['ai', 'conversation', 'list', { page, includeDeleted }],
    queryFn: () =>
      client.agent.conversation.list({ page, size: PAGE_SIZE, includeDeleted }),
  })

  // 运行列表：一次 100 条（含子 agent），前端据此拼父子树；不够再加载
  const runsQuery = useInfiniteQuery({
    enabled: drawerOpen && Boolean(conversation),
    queryKey: ['ai', 'run', 'list', { conversationId: conversation?.id }],
    queryFn: ({ pageParam }) =>
      client.agent.run.list({
        conversationId: conversation!.id,
        page: pageParam,
        size: STREAM_PAGE_SIZE,
      }),
    initialPageParam: 1,
    getNextPageParam: nextPageParam,
  })

  const runDetailQuery = useQuery({
    enabled: drawerOpen && Boolean(runId),
    queryKey: ['ai', 'run', 'detail', { runId }],
    queryFn: () => client.agent.run.detail({ runId: runId! }),
  })

  // 时间线：按 100 条一页续取。审计场景可能上万条，不能指望一次装下
  const timelineQuery = useInfiniteQuery({
    enabled: drawerOpen && Boolean(conversation),
    queryKey: ['ai', 'timeline', 'list', { conversationId: conversation?.id, runId }],
    queryFn: ({ pageParam }) =>
      client.agent.timeline.list({
        conversationId: conversation!.id,
        ...(runId ? { runId } : {}),
        page: pageParam,
        size: STREAM_PAGE_SIZE,
      }),
    initialPageParam: 1,
    getNextPageParam: nextPageParam,
  })

  const runs = runsQuery.data?.pages.flatMap((item) => item.items) ?? []
  const runTotal = runsQuery.data?.pages[0]?.total ?? 0
  const timeline = timelineQuery.data?.pages.flatMap((item) => item.items) ?? []
  const timelineTotal = timelineQuery.data?.pages[0]?.total ?? 0

  const openRuns = (next: AgentConversationModel) => {
    setConversation(next)
    setRunId(undefined)
    setDrawerOpen(true)
  }

  const closeDrawer = (open: boolean) => {
    setDrawerOpen(open)
    if (!open) setRunId(undefined)
  }

  const conversationColumns: DataTableColumnDef<AgentConversationModel>[] = [
    {
      header: '会话',
      accessorKey: 'title',
      cell: ({ row }) => (
        <div className="flex flex-col gap-1">
          <span className="font-medium">{row.original.title || '(无标题)'}</span>
          <span className="font-mono text-xs text-muted-foreground">{row.original.id}</span>
        </div>
      ),
    },
    {
      header: 'Agent',
      accessorKey: 'agentKey',
      meta: { width: 140 },
      cell: ({ row }) => <Badge variant="secondary">{row.original.agentKey}</Badge>,
    },
    {
      header: '状态',
      accessorKey: 'status',
      meta: { width: 100 },
      cell: ({ row }) => <DictTag dict={ConversationStatus} value={row.original.status} />,
    },
    {
      header: '轮数',
      accessorKey: 'turnCount',
      meta: { width: 80 },
      cell: ({ getValue }) => (
        <span className="text-xs tabular-nums text-muted-foreground">{String(getValue())}</span>
      ),
    },
    {
      header: '累计 token',
      accessorKey: 'totalTokens',
      meta: { width: 120 },
      cell: ({ getValue }) => (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {String(getValue() ?? '-')}
        </span>
      ),
    },
    {
      header: '最后活动',
      accessorKey: 'lastActiveAt',
      meta: { width: 180 },
      cell: ({ row }) => (
        <DisplayValue
          type="date"
          value={row.original.lastActiveAt}
          className="text-xs text-muted-foreground"
        />
      ),
    },
    {
      header: '操作',
      id: 'actions',
      meta: { width: 110 },
      cell: ({ row }) => (
        <Button
          size="sm"
          variant={
            drawerOpen && conversation?.id === row.original.id ? 'default' : 'outline'
          }
          onClick={() => openRuns(row.original)}
        >
          查看运行
        </Button>
      ),
    },
  ]

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4 sm:py-6">
      <DataTable<AgentConversationModel>
        title="AI 会话审计"
        description="按会话 → 运行 → 时间线三层复盘；点「查看运行」在右侧抽屉查看，运行与时间线只读（审计证据，不提供删除）"
        columns={conversationColumns}
        data={conversationsQuery.data?.items}
        loading={conversationsQuery.isFetching}
        rowKey="id"
        page={page}
        pageSize={PAGE_SIZE}
        total={conversationsQuery.data?.total}
        onPageChange={(next) => setPage(next)}
        toolbar={
          <div className="flex items-center gap-4">
            <Label className="gap-2 text-sm font-normal text-muted-foreground">
              <Switch checked={includeDeleted} onCheckedChange={setIncludeDeleted} />
              含已删除会话
            </Label>
            <RefreshButton onClick={() => void conversationsQuery.refetch()} />
          </div>
        }
      />

      <Sheet open={drawerOpen} onOpenChange={closeDrawer}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 overflow-hidden p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[50vw]"
        >
          <SheetHeader className="shrink-0 bg-surface-1 pr-12">
            <SheetTitle className="truncate">
              运行记录：{conversation?.title || conversation?.id || '—'}
            </SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono">{conversation?.id}</span>
              <span>{conversation?.agentKey}</span>
              {conversation ? (
                <DictTag dict={ConversationStatus} value={conversation.status} />
              ) : null}
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">
                  运行记录
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    {runsQuery.isLoading ? '加载中…' : `共 ${runTotal} 条`}
                  </span>
                </h3>
                <RefreshButton
                  onClick={() => {
                    void runsQuery.refetch()
                    void timelineQuery.refetch()
                    void runDetailQuery.refetch()
                  }}
                />
              </div>

              <div className="flex flex-col gap-1">
                {runs.map((run) => (
                  <Button
                    key={run.id}
                    variant="ghost"
                    className={cn(
                      'flex h-auto w-full flex-col items-stretch justify-start gap-1 rounded-md bg-surface-1 px-3 py-2 text-left font-normal whitespace-normal',
                      runId === run.id && 'bg-surface-3',
                    )}
                    onClick={() => setRunId(runId === run.id ? undefined : run.id)}
                  >
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className={cn('font-mono', run.depth > 0 && 'text-muted-foreground')}>
                        {run.depth > 0 ? '└ ' : ''}
                        {run.agentKey}
                      </span>
                      <Badge variant={run.depth > 0 ? 'outline' : 'secondary'}>
                        {run.depth === 0 ? '本轮' : '子助手'}
                      </Badge>
                      <DictTag dict={RunStatus} value={run.status} />
                      <span className="text-xs text-muted-foreground">
                        {run.stepCount} 步 / {run.toolCallCount} 次工具 ·{' '}
                        {formatDuration(run.durationMs)} · {tokenSummary(run.usage)}
                      </span>
                      <span className="ml-auto text-xs text-primary">
                        {runId === run.id ? '收起快照' : '看输入快照'}
                      </span>
                    </div>
                    {run.errorStage ? (
                      <span className="text-xs text-destructive">
                        {run.errorStage}
                        {run.errorMessage ? `：${run.errorMessage}` : ''}
                      </span>
                    ) : null}
                    <span className="flex flex-wrap gap-3 font-mono text-xs text-muted-foreground">
                      <span>{run.id}</span>
                      <span>
                        <DisplayValue type="date" value={run.startedAt} />
                      </span>
                    </span>
                  </Button>
                ))}
                {!runsQuery.isLoading && runs.length === 0 ? (
                  <span className="text-sm text-muted-foreground">这个会话还没有运行记录</span>
                ) : null}
                {runsQuery.hasNextPage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={runsQuery.isFetchingNextPage}
                    onClick={() => void runsQuery.fetchNextPage()}
                  >
                    {runsQuery.isFetchingNextPage ? '加载中…' : '加载更多运行'}
                  </Button>
                ) : null}
              </div>
            </section>

            {runId && runDetailQuery.data ? (
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">输入快照（当时送给模型的输入）</h3>
                  <Button size="sm" variant="ghost" onClick={() => setRunId(undefined)}>
                    收起
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>runId：{runDetailQuery.data.id}</span>
                  <span>请求 id：{runDetailQuery.data.requestId ?? '—'}</span>
                  <span>发起人：{runDetailQuery.data.triggeredBy ?? '—'}</span>
                  <span>恢复次数：{runDetailQuery.data.recoveryCount}</span>
                </div>
                <pre className="max-h-72 overflow-auto rounded-md bg-surface-1 p-3 text-xs">
                  {JSON.stringify(runDetailQuery.data.requestSnapshot ?? {}, null, 2)}
                </pre>
                {runDetailQuery.data.errorDetail ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-destructive">
                      上游错误原文（全量）
                    </span>
                    <pre className="max-h-60 overflow-auto rounded-md bg-destructive/10 p-3 text-xs">
                      {JSON.stringify(runDetailQuery.data.errorDetail, null, 2)}
                    </pre>
                  </div>
                ) : null}
                {runDetailQuery.data.children.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium">
                      子助手（{runDetailQuery.data.children.length}）
                    </span>
                    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                      {runDetailQuery.data.children.map((child) => (
                        <Button
                          key={child.id}
                          variant="ghost"
                          className="flex h-auto w-full items-center justify-between rounded-md bg-surface-1 px-3 py-2 text-left font-normal whitespace-normal"
                          onClick={() => setRunId(child.id)}
                        >
                          <span className="font-mono">{child.agentKey}</span>
                          <span>
                            {child.stepCount} 步 / {child.toolCallCount} 次工具 ·{' '}
                            {formatDuration(child.durationMs)} · {tokenSummary(child.usage)}
                          </span>
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">
                  时间线
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    {runId ? '（只看这一轮 / 该子助手）' : '（整个会话，含子 agent）'} ·{' '}
                    {timelineQuery.isLoading
                      ? '加载中…'
                      : `${timeline.length} / ${timelineTotal} 条`}
                  </span>
                </h3>
                <RefreshButton onClick={() => void timelineQuery.refetch()} />
              </div>
              <div className="flex flex-col gap-2">
                {timeline.map((item) => (
                  <TimelineRow key={item.id} item={item} />
                ))}
                {!timelineQuery.isLoading && timeline.length === 0 ? (
                  <span className="text-sm text-muted-foreground">没有事件</span>
                ) : null}
                {timelineQuery.hasNextPage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={timelineQuery.isFetchingNextPage}
                    onClick={() => void timelineQuery.fetchNextPage()}
                  >
                    {timelineQuery.isFetchingNextPage ? '加载中…' : '加载更多事件'}
                  </Button>
                ) : null}
              </div>
            </section>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

/** 一条时间线事件：头部是"谁 / 什么类型 / 什么时候 / 花了多久"，正文按类型渲染 */
function TimelineRow({ item }: { item: AgentTimelineItemModel }) {
  const text = item.payload?.text
  return (
    <details className="group rounded-md bg-surface-1 px-3 py-2">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">#{item.seq}</span>
        <DictTag dict={TimelineKind} value={item.kind} emptyText={<span>{item.kind}</span>} />
        <DictTag dict={TimelineRole} value={item.role} emptyText={<span>{item.role}</span>} />
        {item.toolKey ? <Badge variant="outline">{item.toolKey}</Badge> : null}
        {item.runId ? <span className="font-mono">run:{item.runId.slice(-6)}</span> : null}
        <span>
          <DisplayValue type="date" value={item.startedAt} />
        </span>
        <span>{formatDuration(item.durationMs)}</span>
        {item.usage ? <span>token {String(item.usage.totalTokens ?? '—')}</span> : null}
        {item.state ? <span>{item.state}</span> : null}
      </summary>
      <div className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-sm">
        {typeof text === 'string' ? (
          <Markdown content={text} />
        ) : (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-2 text-xs">
            {JSON.stringify(item.payload ?? {}, null, 2)}
          </pre>
        )}
      </div>
    </details>
  )
}
