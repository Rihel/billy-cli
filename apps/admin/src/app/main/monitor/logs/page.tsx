'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { MonitorAlertModel } from '@repo/shared'
import {
  Button,
  DataTable,
  DictSelect,
  DisplayValue,
  Input,
  RefreshButton,
  Tag,
  useDisclosure,
} from '@repo/ui'
import type { DataTableColumnDef } from '@repo/ui'
import { EyeIcon, SearchIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import { AlertDetailDialog } from './alert-detail'

const LEVEL_META = {
  warn: { label: '警告', color: 'warning' },
  error: { label: '错误', color: 'error' },
  critical: { label: '严重', color: 'error' },
} as const

export default function MonitorAlertsPage() {
  const client = useServerClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [level, setLevel] = useState<'warn' | 'error' | 'critical' | undefined>()
  const [status, setStatus] = useState<'firing' | 'resolved' | undefined>()
  const [ruleKey, setRuleKey] = useState<string | undefined>()
  const [ruleInput, setRuleInput] = useState('')
  const detailDialog = useDisclosure<MonitorAlertModel>()

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['monitor', 'alert', 'page', { page, pageSize, level, status, ruleKey }],
    queryFn: () =>
      client.monitor.alert.pageQuery({
        page,
        size: pageSize,
        level,
        status,
        ruleKey,
        orderBy: 'firstFiredAt',
        order: 'desc',
      }),
  })

  const columns: DataTableColumnDef<MonitorAlertModel>[] = [
    {
      header: '首次告警',
      accessorKey: 'firstFiredAt',
      meta: { width: 170 },
      cell: ({ getValue }) => (
        <DisplayValue type="date" value={getValue()} className="text-xs text-muted-foreground" />
      ),
    },
    {
      header: '级别',
      accessorKey: 'level',
      meta: { width: 80 },
      cell: ({ getValue }) => {
        const meta = LEVEL_META[getValue() as keyof typeof LEVEL_META]
        return <Tag color={meta?.color ?? 'warning'}>{meta?.label ?? String(getValue())}</Tag>
      },
    },
    {
      header: '状态',
      accessorKey: 'status',
      meta: { width: 90 },
      cell: ({ getValue }) =>
        getValue() === 'firing' ? (
          <Tag color="error">未恢复</Tag>
        ) : (
          <Tag color="success">已恢复</Tag>
        ),
    },
    {
      header: '规则',
      accessorKey: 'ruleName',
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{row.original.ruleName}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{row.original.ruleKey}</span>
        </div>
      ),
    },
    {
      header: '主体',
      accessorKey: 'subjectId',
      cell: ({ getValue }) => (
        <span className="font-mono text-[11px] text-muted-foreground">{String(getValue())}</span>
      ),
    },
    {
      header: '持续',
      accessorKey: 'durationMs',
      meta: { width: 110 },
      cell: ({ getValue }) => (
        <span className="text-xs tabular-nums text-foreground/80">
          {formatDuration(getValue() as number | null | undefined)}
        </span>
      ),
    },
    {
      header: '最近命中',
      accessorKey: 'lastFiredAt',
      meta: { width: 170 },
      cell: ({ getValue }) => (
        <DisplayValue type="date" value={getValue()} className="text-xs text-muted-foreground" />
      ),
    },
    {
      header: '恢复时间',
      accessorKey: 'recoveredAt',
      meta: { width: 170 },
      cell: ({ getValue }) => (
        <DisplayValue
          type="date"
          value={getValue()}
          emptyText="未恢复"
          className="text-xs text-muted-foreground"
        />
      ),
    },
    {
      header: '操作',
      id: 'actions',
      meta: { width: 80 },
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => detailDialog.open(row.original)}>
          <EyeIcon className="size-3.5" />
          详情
        </Button>
      ),
    },
  ]

  return (
    <div className="h-full w-full overflow-auto p-4 sm:py-6">
      <DataTable<MonitorAlertModel>
        title="告警记录"
        description="一条告警从首次命中到恢复的完整记录；详情可看首末数据快照与逐通道发送记录。"
        toolbar={
          <>
            <RefreshButton loading={isFetching} onClick={() => void refetch()} />
            <DictSelect
              options={[
                { label: '警告', value: 'warn' },
                { label: '错误', value: 'error' },
                { label: '严重', value: 'critical' },
              ]}
              value={level ?? null}
              allowClear
              placeholder="全部级别"
              triggerClassName="w-28"
              onValueChange={(value) => {
                setLevel(
                  value === 'warn' || value === 'error' || value === 'critical'
                    ? value
                    : undefined,
                )
                setPage(1)
              }}
            />
            <DictSelect
              options={[
                { label: '未恢复', value: 'firing' },
                { label: '已恢复', value: 'resolved' },
              ]}
              value={status ?? null}
              allowClear
              placeholder="全部状态"
              triggerClassName="w-28"
              onValueChange={(value) => {
                setStatus(value === 'firing' || value === 'resolved' ? value : undefined)
                setPage(1)
              }}
            />
          </>
        }
        search={
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setRuleKey(ruleInput.trim() || undefined)
              setPage(1)
            }}
          >
            <Input
              value={ruleInput}
              placeholder="规则 key"
              className="w-56"
              onChange={(event) => setRuleInput(event.target.value)}
            />
            <Button type="submit" variant="outline" size="sm">
              <SearchIcon className="size-3.5" />
              筛选
            </Button>
          </form>
        }
        rowKey="id"
        loading={isFetching}
        columns={columns}
        data={data?.items}
        page={page}
        pageSize={pageSize}
        total={data?.total}
        onPageChange={(nextPage, nextPageSize) => {
          setPage(nextPage)
          setPageSize(nextPageSize)
        }}
      />

      <AlertDetailDialog
        alert={detailDialog.data ?? null}
        open={detailDialog.isOpen}
        onClose={detailDialog.close}
      />
    </div>
  )
}

function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined) return '-'
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}
