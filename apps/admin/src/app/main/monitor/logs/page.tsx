'use client'

import { useServerClient } from '@/lib/server-client'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  DataTable,
  DictSelect,
  DisplayValue,
  EmptyValue,
  RefreshButton,
  Tag,
} from '@repo/ui'
import type { DataTableColumnDef } from '@repo/ui'
import type { AlertLogModel } from '@repo/shared'

export default function AlertLogsPage() {
  const client = useServerClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [channel, setChannel] = useState<'lark' | 'email' | undefined>()
  const [status, setStatus] = useState<'success' | 'failed' | undefined>()

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['monitor', 'logs', { page, pageSize, channel, status }],
    queryFn: () =>
      client.monitor.log.pageQuery({
        page,
        size: pageSize,
        channel,
        status,
        orderBy: 'sentAt',
        order: 'desc',
      }),
  })

  const columns: DataTableColumnDef<AlertLogModel>[] = [
    {
      header: '发送时间',
      accessorKey: 'sentAt',
      meta: { width: 180 },
      cell: ({ getValue }) => <DisplayValue type="date" value={getValue()} />,
    },
    { header: '规则', accessorKey: 'ruleName' },
    { header: '标题', accessorKey: 'title' },
    {
      header: '通道',
      accessorKey: 'channel',
      meta: { width: 100 },
      cell: ({ getValue }) => (
        <Tag color="cyan">{getValue() === 'lark' ? '飞书' : '邮件'}</Tag>
      ),
    },
    {
      header: '状态',
      accessorKey: 'status',
      meta: { width: 100 },
      cell: ({ getValue }) =>
        getValue() === 'success' ? (
          <Tag color="green">成功</Tag>
        ) : (
          <Tag color="red">失败</Tag>
        ),
    },
    {
      header: '失败原因',
      accessorKey: 'error',
      cell: ({ getValue }) => (
        <EmptyValue value={getValue()} emptyText="-">
          <span className="text-destructive">{getValue()}</span>
        </EmptyValue>
      ),
    },
  ]

  return (
    <div className="h-full w-full overflow-auto p-4 sm:p-6">
      <DataTable<AlertLogModel>
        title="告警记录"
        description="告警发送记录，可按通道与状态回溯"
        toolbar={
          <>
            <RefreshButton loading={isFetching} onClick={() => void refetch()} />
            <DictSelect
              options={[
                { label: '飞书', value: 'lark' },
                { label: '邮件', value: 'email' },
              ]}
              value={channel ?? null}
              allowClear
              placeholder="全部"
              triggerClassName="w-24"
              onValueChange={(value) => {
                setChannel(
                  value === 'lark' || value === 'email' ? value : undefined,
                )
                setPage(1)
              }}
            />
            <DictSelect
              options={[
                { label: '成功', value: 'success' },
                { label: '失败', value: 'failed' },
              ]}
              value={status ?? null}
              allowClear
              placeholder="全部"
              triggerClassName="w-24"
              onValueChange={(value) => {
                setStatus(
                  value === 'success' || value === 'failed' ? value : undefined,
                )
                setPage(1)
              }}
            />
          </>
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
    </div>
  )
}
