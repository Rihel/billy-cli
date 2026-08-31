'use client'

import { useServerClient } from '@/lib/server-client'
import { Select, Tag } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { TableColumnsType } from 'antd'
import { DataTable, DisplayValue, EmptyValue, RefreshButton } from '@repo/aui'
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

  const columns: TableColumnsType<AlertLogModel> = [
    {
      title: '发送时间',
      dataIndex: 'sentAt',
      width: 180,
      render: (value) => <DisplayValue type="date" value={value} />,
    },
    { title: '规则', dataIndex: 'ruleName' },
    { title: '标题', dataIndex: 'title' },
    {
      title: '通道',
      dataIndex: 'channel',
      width: 100,
      render: (value: AlertLogModel['channel']) => (
        <Tag color="cyan">{value === 'lark' ? '飞书' : '邮件'}</Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: AlertLogModel['status']) =>
        value === 'success' ? (
          <Tag color="green">成功</Tag>
        ) : (
          <Tag color="red">失败</Tag>
        ),
    },
    {
      title: '失败原因',
      dataIndex: 'error',
      render: (value: string | null) => (
        <EmptyValue value={value} emptyText="-">
          <span className="text-red-500">{value}</span>
        </EmptyValue>
      ),
    },
  ]

  return (
    <div className="w-full h-full bg-white p-5">
      <DataTable<AlertLogModel>
        title="告警记录"
        toolbar={
          <>
            <RefreshButton loading={isFetching} onClick={() => void refetch()} />
            <Select
              allowClear
              placeholder="通道"
              style={{ width: 110 }}
              value={channel}
              options={[
                { label: '飞书', value: 'lark' },
                { label: '邮件', value: 'email' },
              ]}
              onChange={(value) => {
                setChannel(value)
                setPage(1)
              }}
            />
            <Select
              allowClear
              placeholder="状态"
              style={{ width: 110 }}
              value={status}
              options={[
                { label: '成功', value: 'success' },
                { label: '失败', value: 'failed' },
              ]}
              onChange={(value) => {
                setStatus(value)
                setPage(1)
              }}
            />
          </>
        }
        rowKey="id"
        loading={isFetching}
        columns={columns}
        dataSource={data?.items}
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
