'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  DictTag,
  DisplayValue,
  Markdown,
  RefreshButton,
  Switch,
  cn,
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
  AgentRunModel,
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
 */
const PAGE_SIZE = 10
const TIMELINE_SIZE = 200

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

export default function AiAuditPage() {
  const client = useServerClient()
  const [page, setPage] = useState(1)
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [conversation, setConversation] = useState<AgentConversationModel>()
  const [runId, setRunId] = useState<string>()

  const conversationsQuery = useQuery({
    queryKey: ['ai', 'conversation', 'list', { page, includeDeleted }],
    queryFn: () =>
      client.agent.conversation.list({ page, size: PAGE_SIZE, includeDeleted }),
  })

  // 运行列表：一次拿全（含子 agent），前端据此拼父子树
  const runsQuery = useQuery({
    enabled: Boolean(conversation),
    queryKey: ['ai', 'run', 'list', { conversationId: conversation?.id }],
    queryFn: () =>
      client.agent.run.list({
        conversationId: conversation!.id,
        page: 1,
        size: 100,
      }),
  })

  const runDetailQuery = useQuery({
    enabled: Boolean(runId),
    queryKey: ['ai', 'run', 'detail', { runId }],
    queryFn: () => client.agent.run.detail({ runId: runId! }),
  })

  const timelineQuery = useQuery({
    enabled: Boolean(conversation),
    queryKey: ['ai', 'timeline', 'list', { conversationId: conversation?.id, runId }],
    queryFn: () =>
      client.agent.timeline.list({
        conversationId: conversation!.id,
        ...(runId ? { runId } : {}),
        page: 1,
        size: TIMELINE_SIZE,
      }),
  })

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
    },
    {
      header: '累计 token',
      accessorKey: 'totalTokens',
      meta: { width: 120 },
    },
    {
      header: '最后活动',
      accessorKey: 'lastActiveAt',
      meta: { width: 180 },
      cell: ({ row }) => <DisplayValue type="date" value={row.original.lastActiveAt} />,
    },
    {
      header: '操作',
      id: 'actions',
      meta: { width: 110 },
      cell: ({ row }) => (
        <Button
          size="sm"
          variant={conversation?.id === row.original.id ? 'default' : 'outline'}
          onClick={() => {
            setConversation(row.original)
            setRunId(undefined)
          }}
        >
          查看运行
        </Button>
      ),
    },
  ]

  const runs = runsQuery.data?.items ?? []
  const runColumns: DataTableColumnDef<AgentRunModel>[] = [
    {
      header: '层级',
      accessorKey: 'depth',
      meta: { width: 200 },
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <span className={cn(row.original.depth > 0 && 'pl-4 text-muted-foreground')}>
            {row.original.depth > 0 ? '└ ' : ''}
            {row.original.depth === 0 ? '本轮' : '子助手'}
          </span>
          <span className="font-mono text-xs">{row.original.agentKey}</span>
        </div>
      ),
    },
    {
      header: '状态',
      accessorKey: 'status',
      meta: { width: 100 },
      cell: ({ row }) => <DictTag dict={RunStatus} value={row.original.status} />,
    },
    {
      header: '步 / 工具',
      id: 'counts',
      meta: { width: 110 },
      cell: ({ row }) => `${row.original.stepCount} / ${row.original.toolCallCount}`,
    },
    { header: '耗时', accessorKey: 'durationMs', meta: { width: 100 }, cell: ({ row }) => formatDuration(row.original.durationMs) },
    {
      header: '消耗',
      accessorKey: 'usage',
      meta: { width: 220 },
      cell: ({ row }) => tokenSummary(row.original.usage),
    },
    {
      header: '失败环节',
      accessorKey: 'errorStage',
      meta: { width: 140 },
      cell: ({ row }) =>
        row.original.errorStage ? (
          <span className="text-destructive">
            {row.original.errorStage}
            {row.original.errorMessage ? `：${row.original.errorMessage}` : ''}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      header: '开始时间',
      accessorKey: 'startedAt',
      meta: { width: 180 },
      cell: ({ row }) => <DisplayValue type="date" value={row.original.startedAt} />,
    },
    {
      header: '操作',
      id: 'actions',
      meta: { width: 130 },
      cell: ({ row }) => (
        <Button
          size="sm"
          variant={runId === row.original.id ? 'default' : 'outline'}
          onClick={() => setRunId(runId === row.original.id ? undefined : row.original.id)}
        >
          {runId === row.original.id ? '看整个会话' : '只看这一轮'}
        </Button>
      ),
    },
  ]

  const timeline = timelineQuery.data?.items ?? []

  return (
    <div className="flex flex-col gap-4">
      <DataTable<AgentConversationModel>
        title="AI 会话审计"
        description="按会话 → 运行 → 时间线三层复盘；运行与时间线只读（审计证据，不提供删除）"
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
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={includeDeleted} onCheckedChange={setIncludeDeleted} />
              含已删除会话
            </label>
            <RefreshButton
              onClick={() => {
                void conversationsQuery.refetch()
                void runsQuery.refetch()
                void timelineQuery.refetch()
                void runDetailQuery.refetch()
              }}
            />
          </div>
        }
      />

      {conversation ? (
        <DataTable<AgentRunModel>
          title={`运行记录：${conversation.title || conversation.id}`}
          description="一次问答一行；子 agent 是独立一行（同一张表，靠父子列分树）——它的消耗已汇总进父的合计"
          columns={runColumns}
          data={runs}
          loading={runsQuery.isFetching}
          rowKey="id"
          emptyText="这个会话还没有运行记录"
        />
      ) : null}

      {conversation && runId && runDetailQuery.data ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">
              输入快照（复盘：当时**送给模型的输入**）
            </CardTitle>
            <Button size="sm" variant="ghost" onClick={() => setRunId(undefined)}>
              关闭
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>runId：{runDetailQuery.data.id}</span>
              <span>请求 id：{runDetailQuery.data.requestId ?? '—'}</span>
              <span>发起人：{runDetailQuery.data.triggeredBy ?? '—'}</span>
              <span>恢复次数：{runDetailQuery.data.recoveryCount}</span>
            </div>
            <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
              {JSON.stringify(runDetailQuery.data.requestSnapshot ?? {}, null, 2)}
            </pre>
            {runDetailQuery.data.errorDetail ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-destructive">上游错误原文（全量）</span>
                <pre className="max-h-60 overflow-auto rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
                  {JSON.stringify(runDetailQuery.data.errorDetail, null, 2)}
                </pre>
              </div>
            ) : null}
            {runDetailQuery.data.children.length > 0 ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">子助手（{runDetailQuery.data.children.length}）</span>
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {runDetailQuery.data.children.map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-left hover:bg-muted/50"
                      onClick={() => setRunId(child.id)}
                    >
                      <span className="font-mono">{child.agentKey}</span>
                      <span>
                        {child.stepCount} 步 / {child.toolCallCount} 次工具 ·{' '}
                        {formatDuration(child.durationMs)} · {tokenSummary(child.usage)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {conversation ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">
              时间线{runId ? '（只看这一轮 / 该子助手）' : '（整个会话，含子 agent）'}
            </CardTitle>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>共 {timeline.length} 条</span>
              <RefreshButton onClick={() => void timelineQuery.refetch()} />
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex max-h-[36rem] flex-col gap-2 overflow-auto pr-1">
              {timeline.map((item) => (
                <TimelineRow key={item.id} item={item} />
              ))}
              {timeline.length === 0 && !timelineQuery.isFetching ? (
                <span className="text-sm text-muted-foreground">没有事件</span>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

/** 一条时间线事件：头部是"谁 / 什么类型 / 什么时候 / 花了多久"，正文按类型渲染 */
function TimelineRow({ item }: { item: AgentTimelineItemModel }) {
  const text = item.payload?.text
  return (
    <details className="group rounded-md border border-border bg-card px-3 py-2">
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
      <div className="mt-2 border-t border-border pt-2 text-sm">
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
