'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  DateRangePicker,
  DisplayValue,
  RefreshButton,
} from '@repo/ui'
import type { DataTableColumnDef, DateRangeValue } from '@repo/ui'
import type {
  GatewayUsageItemModel,
  GatewayUsageListDto,
  GatewayUsageReconcileItemModel,
  GatewayUsageStatus,
} from '@repo/shared'
import { useServerClient } from '@/lib/server-client'

const PAGE_SIZE = 20

const todayKey = (): string => new Date().toISOString().slice(0, 10)
const shift = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

const defaultRange = (): DateRangeValue => {
  const to = todayKey()
  return { from: shift(to, -6), to }
}

const formatCost = (micros: number): string => `¥${(micros / 1_000_000).toFixed(4)}`
const formatTokens = (value: number | null): string =>
  value === null ? '—' : value.toLocaleString()
const formatMs = (value: number | null): string => (value === null ? '—' : `${value} ms`)

const statusVariant: Record<
  GatewayUsageStatus,
  'default' | 'destructive' | 'secondary' | 'outline'
> = {
  success: 'default',
  error: 'destructive',
  aborted: 'secondary',
  rejected: 'outline',
}

const columns = (): DataTableColumnDef<GatewayUsageItemModel>[] => [
  {
    id: 'createdAt',
    header: '时间',
    cell: ({ row }) => <DisplayValue type="date" value={row.original.createdAt} />,
  },
  {
    id: 'status',
    header: '状态',
    cell: ({ row }) => (
      <Badge variant={statusVariant[row.original.status] ?? 'outline'}>
        {row.original.status}
        {row.original.httpStatus ? ` ${row.original.httpStatus}` : ''}
      </Badge>
    ),
  },
  {
    id: 'model',
    header: '模型',
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="text-sm">{row.original.modelName ?? row.original.modelKey ?? '—'}</span>
        <span className="text-xs text-muted-foreground">{row.original.providerName ?? '—'}</span>
      </div>
    ),
  },
  {
    id: 'run',
    header: '归因',
    cell: ({ row }) => (
      <div className="flex flex-col text-xs text-muted-foreground">
        <span>{row.original.runId ?? '非 run 调用'}</span>
        <span>{row.original.conversationId ?? ''}</span>
      </div>
    ),
  },
  {
    id: 'tokens',
    header: 'Token（入/出/总）',
    cell: ({ row }) => (
      <span className="font-mono text-xs">
        {formatTokens(row.original.inputTokens)} / {formatTokens(row.original.outputTokens)} /{' '}
        {formatTokens(row.original.totalTokens)}
      </span>
    ),
  },
  {
    id: 'cost',
    header: '成本',
    cell: ({ row }) =>
      row.original.costMicros === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className="font-mono text-xs">{formatCost(row.original.costMicros)}</span>
      ),
  },
  {
    id: 'latency',
    header: 'TTFT / 耗时',
    cell: ({ row }) => (
      <span className="font-mono text-xs">
        {formatMs(row.original.ttftMs)} / {formatMs(row.original.durationMs)}
      </span>
    ),
  },
  {
    id: 'stream',
    header: '流式',
    cell: ({ row }) => (row.original.stream ? '是' : '否'),
  },
]

const reconcileColumns = (): DataTableColumnDef<GatewayUsageReconcileItemModel>[] => [
  { id: 'runId', header: 'run', cell: ({ row }) => row.original.runId },
  {
    id: 'conversationId',
    header: '会话',
    cell: ({ row }) => row.original.conversationId ?? '—',
  },
  {
    id: 'gateway',
    header: 'gateway 调用 / token',
    cell: ({ row }) =>
      `${row.original.gatewayCalls} / ${formatTokens(row.original.gatewayTotalTokens)}`,
  },
  {
    id: 'run',
    header: 'runs.usage token',
    cell: ({ row }) => formatTokens(row.original.runTotalTokens),
  },
  {
    id: 'delta',
    header: '差异',
    cell: ({ row }) =>
      row.original.delta === null ? (
        <span className="text-muted-foreground">无 run 记录</span>
      ) : (
        <span className={row.original.delta === 0 ? 'text-success' : 'text-warning'}>
          {row.original.delta > 0 ? '+' : ''}
          {row.original.delta}
        </span>
      ),
  },
  {
    id: 'status',
    header: 'run 状态',
    cell: ({ row }) => row.original.runStatus ?? '—',
  },
]

/**
 * 网关用量 / 成本（`/main/ai/usage`，管理员）。
 *
 * 看的是**调用口径**：每次上游尝试一行（含重试 / 失败），与 `runs.usage` 的业务口径
 * 分开呈现；「对账」只找差异，不自动修正。
 */
export default function GatewayUsagePage() {
  const client = useServerClient()
  const [range, setRange] = useState<DateRangeValue>(defaultRange)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [status, setStatus] = useState<GatewayUsageStatus | undefined>()
  const [showReconcile, setShowReconcile] = useState(false)

  const filters = useMemo<GatewayUsageListDto>(
    () => ({
      page,
      size: pageSize,
      ...(range.from ? { from: range.from } : {}),
      ...(range.to ? { to: range.to } : {}),
      ...(status ? { status } : {}),
    }),
    [page, pageSize, range.from, range.to, status],
  )

  const summaryQuery = useQuery({
    queryKey: ['gatewayUsage', 'summary', range],
    queryFn: () =>
      client.agent.gatewayUsage.summary({
        ...(range.from ? { from: range.from } : {}),
        ...(range.to ? { to: range.to } : {}),
      }),
  })

  const listQuery = useQuery({
    queryKey: ['gatewayUsage', 'list', filters],
    queryFn: () => client.agent.gatewayUsage.list(filters),
  })

  const reconcileQuery = useQuery({
    queryKey: ['gatewayUsage', 'reconcile', range, showReconcile],
    enabled: showReconcile,
    queryFn: () =>
      client.agent.gatewayUsage.reconcile({
        page: 1,
        size: 20,
        ...(range.from ? { from: range.from } : {}),
        ...(range.to ? { to: range.to } : {}),
        onlyDiff: true,
      }),
  })

  const summary = summaryQuery.data
  const successRate =
    summary && summary.totals.calls > 0
      ? `${Math.round((summary.totals.success / summary.totals.calls) * 100)}%`
      : '—'

  const refresh = (): void => {
    void summaryQuery.refetch()
    void listQuery.refetch()
    if (showReconcile) void reconcileQuery.refetch()
  }

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">网关用量 / 成本</h1>
          <p className="text-sm text-muted-foreground">
            调用口径：每次上游尝试一行（含重试 / 失败）；与业务 run 统计分开。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DateRangePicker
            value={range}
            onChange={(next) => {
              setRange(next)
              setPage(1)
            }}
          />
          <Button
            variant={showReconcile ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setShowReconcile((value) => !value)}
          >
            {showReconcile ? '收起对账' : '与 runs.usage 对账'}
          </Button>
          <RefreshButton onClick={refresh} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          title="调用次数"
          value={summary ? summary.totals.calls.toLocaleString() : '—'}
        />
        <MetricCard title="成功率" value={successRate} />
        <MetricCard
          title="总 Token"
          value={summary ? summary.totals.totalTokens.toLocaleString() : '—'}
          hint={
            summary
              ? `入 ${summary.totals.inputTokens} / 出 ${summary.totals.outputTokens}`
              : undefined
          }
        />
        <MetricCard title="成本" value={summary ? formatCost(summary.totals.costMicros) : '—'} />
        <MetricCard
          title="平均 TTFT / 耗时"
          value={summary ? `${summary.totals.avgTtftMs} / ${summary.totals.avgDurationMs} ms` : '—'}
          hint={summary ? `缺 usage ${summary.totals.usageMissing} 次` : undefined}
        />
      </div>

      {showReconcile ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              对账：gateway 调用账 vs runs.usage（仅列出有差异的 run，只读）
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 flex flex-wrap gap-4 text-sm">
              <span>对比 run：{reconcileQuery.data?.comparedRuns ?? '—'}</span>
              <span>有差异：{reconcileQuery.data?.mismatchRuns ?? '—'}</span>
              <span>孤儿 run：{reconcileQuery.data?.orphanRuns ?? '—'}</span>
            </div>
            <DataTable<GatewayUsageReconcileItemModel>
              columns={reconcileColumns()}
              data={reconcileQuery.data?.items ?? []}
              loading={reconcileQuery.isFetching}
              rowKey="runId"
              page={1}
              pageSize={20}
              total={reconcileQuery.data?.total}
              emptyText="窗口内没有差异"
            />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <DimensionCard title="按模型" items={summary?.byModel ?? []} />
        <DimensionCard title="按供应商" items={summary?.byProvider ?? []} />
      </div>

      <DataTable<GatewayUsageItemModel>
        title="调用明细"
        description="每次上游尝试一行；失败 / 重试也会保留"
        columns={columns()}
        data={listQuery.data?.items ?? []}
        loading={listQuery.isFetching}
        rowKey="id"
        page={page}
        pageSize={pageSize}
        total={listQuery.data?.total}
        pageSizeOptions={[10, 20, 50, 100]}
        onPageChange={(nextPage, nextSize) => {
          setPage(nextPage)
          setPageSize(nextSize)
        }}
        emptyText="窗口内没有调用记录"
        toolbar={
          <>
            <Button
              size="sm"
              variant={status === undefined ? 'secondary' : 'outline'}
              onClick={() => {
                setStatus(undefined)
                setPage(1)
              }}
            >
              全部
            </Button>
            <Button
              size="sm"
              variant={status === 'success' ? 'secondary' : 'outline'}
              onClick={() => {
                setStatus('success')
                setPage(1)
              }}
            >
              成功
            </Button>
            <Button
              size="sm"
              variant={status === 'error' ? 'secondary' : 'outline'}
              onClick={() => {
                setStatus('error')
                setPage(1)
              }}
            >
              失败
            </Button>
          </>
        }
      />
    </div>
  )
}

const MetricCard = ({
  title,
  value,
  hint,
}: {
  title: string
  value: string
  hint?: string
}): React.JSX.Element => (
  <Card>
    <CardHeader className="pb-1">
      <CardTitle className="text-xs font-normal text-muted-foreground">{title}</CardTitle>
    </CardHeader>
    <CardContent>
      <div className="font-mono text-xl font-semibold">{value}</div>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </CardContent>
  </Card>
)

const DimensionCard = ({
  title,
  items,
}: {
  title: string
  items: Array<{
    key: string
    label: string
    calls: number
    totalTokens: number
    costMicros: number
  }>
}): React.JSX.Element => (
  <Card>
    <CardHeader className="pb-2">
      <CardTitle className="text-sm">{title}</CardTitle>
    </CardHeader>
    <CardContent className="space-y-2">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无数据</p>
      ) : (
        items.slice(0, 8).map((item) => (
          <div key={item.key} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{item.label}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {item.calls} 次 · {item.totalTokens.toLocaleString()} tok ·{' '}
              {formatCost(item.costMicros)}
            </span>
          </div>
        ))
      )}
    </CardContent>
  </Card>
)
