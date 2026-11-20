'use client'

import { useServerClient } from '@/lib/server-client'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Button,
  ConfirmAction,
  DataTable,
  EmptyValue,
  IconText,
  Input,
  ModalForm,
  RefreshButton,
  Tag,
  toastError,
  toastSuccess,
  useDisclosure,
} from '@repo/ui'
import type { DataTableColumnDef } from '@repo/ui'
import type { MarketItemModel } from '@repo/shared'
import { PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react'

/**
 * AI 市场（v1 只做 MCP 区，`docs/design/workspace-cli-credentials.md` §6.9）。
 *
 * 收录 = 声明，不是安装：这里只登记「市场里有这个 MCP 服务」，
 * 真正的登记 / 探测在「能力服务」页完成。CLI / 技能的个人区随用户端开放。
 */
type MarketForm = {
  key: string
  name: string
  description?: string
  category?: string
  payload: string
}

export default function MarketPage() {
  const client = useServerClient()
  const [keyword, setKeyword] = useState('')
  const dialog = useDisclosure()

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['aiMarket', 'list'],
    queryFn: () => client.aiMarket.list({ type: 'mcp' }),
  })

  const removeMutation = useMutation({
    mutationFn: (input: { key: string }) => client.aiMarket.remove(input),
    onSuccess() {
      void refetch()
      toastSuccess('已下架')
    },
    onError: (error: unknown) => toastError(error instanceof Error ? error.message : '下架失败'),
  })

  const form = useForm({
    defaultValues: {
      key: '',
      name: '',
      category: '',
      description: '',
      payload: '{\n  "service": ""\n}',
    } as MarketForm,
    onSubmit: async ({ value }) => {
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(value.payload) as Record<string, unknown>
      } catch {
        toastError('payload 不是合法 JSON')
        return
      }
      await client.aiMarket.save({
        key: value.key.trim(),
        name: value.name.trim(),
        ...(value.category?.trim() ? { category: value.category.trim() } : {}),
        ...(value.description?.trim() ? { description: value.description.trim() } : {}),
        type: 'mcp',
        payload,
      })
      toastSuccess('已收录')
      await refetch()
      dialog.close()
    },
  })

  const filtered = (data ?? []).filter((item) =>
    keyword.trim()
      ? `${item.key} ${item.name} ${item.category ?? ''}`
          .toLowerCase()
          .includes(keyword.trim().toLowerCase())
      : true,
  )

  const columns: DataTableColumnDef<MarketItemModel>[] = [
    { header: 'key', accessorKey: 'key', meta: { width: 160 } },
    { header: '名称', accessorKey: 'name', meta: { width: 180 } },
    {
      header: '分类',
      accessorKey: 'category',
      meta: { width: 120 },
      cell: ({ row }) => (
        <EmptyValue value={row.original.category} emptyText={<Tag>未分类</Tag>}>
          <Tag color="blue">{row.original.category}</Tag>
        </EmptyValue>
      ),
    },
    {
      header: '说明',
      accessorKey: 'description',
      cell: ({ row }) => (
        <span className="line-clamp-2 text-sm text-muted-foreground">
          {row.original.description ?? '—'}
        </span>
      ),
    },
    {
      header: 'payload',
      accessorKey: 'payload',
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {JSON.stringify(row.original.payload)}
        </span>
      ),
    },
    {
      header: '操作',
      meta: { width: 110 },
      cell: ({ row }) => (
        <ConfirmAction
          title="从市场下架该条目？不会删除能力网关里的服务。"
          onConfirm={() => removeMutation.mutate({ key: row.original.key })}
          danger
        >
          <IconText icon={<Trash2Icon />} size="small" danger>
            下架
          </IconText>
        </ConfirmAction>
      ),
    },
  ]

  return (
    <div className="h-full w-full overflow-auto p-4 sm:py-6">
      <DataTable<MarketItemModel>
        title="AI 市场"
        description="收录 MCP 服务作为市场入口（v1 只做 MCP 区）；收录只准备声明，不安装、不启容器"
        toolbar={
          <>
            <RefreshButton loading={isFetching} onClick={() => void refetch()} />
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 px-2 transition-colors focus-within:ring-2 focus-within:ring-ring/40">
              <SearchIcon className="ml-0.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="搜索 key / 名称 / 分类..."
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                className="h-7 w-52 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
              />
            </div>
            <Button onClick={() => dialog.open()}>
              <PlusIcon />
              收录 MCP
            </Button>
          </>
        }
        rowKey="key"
        loading={isFetching}
        columns={columns}
        data={filtered}
      />

      <ModalForm<MarketForm>
        title="收录 MCP 条目"
        open={dialog.isOpen}
        form={form}
        dialogClassName="sm:max-w-2xl"
        description="key 是稳定标识，重复收录会更新同一条；payload 里记录该条目指向的能力服务（如 { service: 'docs' }）。"
        items={[
          { name: 'key', label: 'key', required: true, hint: '稳定标识，收录后按它幂等更新' },
          { name: 'name', label: '名称', required: true },
          { name: 'category', label: '分类', hint: '可选，如 文档 / 数据 / 协作' },
          { name: 'description', label: '说明', hint: '一句话说明这个服务能做什么' },
          {
            name: 'payload',
            label: 'payload（JSON）',
            widget: 'textarea',
            required: true,
            props: { rows: 8, className: 'font-mono text-xs' },
          },
        ]}
        onCancel={dialog.close}
        onError={(error) => toastError(error instanceof Error ? error.message : '收录失败')}
      />
    </div>
  )
}
