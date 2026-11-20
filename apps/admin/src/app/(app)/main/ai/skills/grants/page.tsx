'use client'

import { useServerClient } from '@/lib/server-client'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Button,
  ConfirmAction,
  DataTable,
  EmptyValue,
  IconText,
  Input,
  RefreshButton,
  Tag,
  toastError,
  toastSuccess,
} from '@repo/ui'
import type { DataTableColumnDef } from '@repo/ui'
import type { SkillGrantModel } from '@repo/shared'
import { PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react'

/**
 * 技能授权管理（`docs/design/workspace-cli-credentials.md` §6.7.2）。
 *
 * 平台技能默认不对外开放；这里维护「谁能看见它」。接口是**覆盖式**的：
 * 页面上的增删都换算成一次 `setGrants(最终集合)`，不会出现增量与覆盖两套语义。
 */
const PRINCIPAL_OPTIONS: { label: string; value: 'user' | 'admin' | 'all' }[] = [
  { label: '用户', value: 'user' },
  { label: '管理员', value: 'admin' },
  { label: '所有人', value: 'all' },
]

export default function SkillGrantsPage() {
  const client = useServerClient()
  const [skillKey, setSkillKey] = useState('')
  const [queryKey, setQueryKey] = useState('')
  const [principalType, setPrincipalType] = useState<'user' | 'admin' | 'all'>('user')
  const [principalId, setPrincipalId] = useState('')

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['skillGrants', queryKey],
    queryFn: () => client.aiSkill.listGrants({ skillKey: queryKey }),
    enabled: queryKey.length > 0,
  })

  const setMutation = useMutation({
    mutationFn: (principals: { principalType: string; principalId: string }[]) =>
      client.aiSkill.setGrants({
        skillKey: queryKey,
        principals: principals as never,
      }),
    onSuccess() {
      void refetch()
      toastSuccess('授权已更新（运行中工作区会同步目录）')
    },
    onError: (error: unknown) => toastError(error instanceof Error ? error.message : '更新失败'),
  })

  const current = (data ?? []).map((item) => ({
    principalType: item.principalType,
    principalId: item.principalId,
  }))

  const add = () => {
    if (!queryKey) {
      toastError('先查询一个技能')
      return
    }
    const id = principalType === 'all' ? '*' : principalId.trim()
    if (!id) {
      toastError('填写主体 id')
      return
    }
    if (current.some((item) => item.principalType === principalType && item.principalId === id)) {
      toastError('该主体已经在列表里')
      return
    }
    setMutation.mutate([...current, { principalType, principalId: id }])
    setPrincipalId('')
  }

  const columns: DataTableColumnDef<SkillGrantModel>[] = [
    {
      header: '主体类型',
      accessorKey: 'principalType',
      meta: { width: 120 },
      cell: ({ row }) => (
        <Tag color="blue">
          {row.original.principalType === 'all'
            ? '所有人'
            : row.original.principalType === 'admin'
              ? '管理员'
              : '用户'}
        </Tag>
      ),
    },
    {
      header: '主体 id',
      accessorKey: 'principalId',
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.principalId}</span>,
    },
    {
      header: '授权人',
      accessorKey: 'grantedBy',
      meta: { width: 160 },
      cell: ({ row }) => (
        <EmptyValue value={row.original.grantedBy} emptyText={<Tag>系统</Tag>}>
          <span className="font-mono text-xs text-muted-foreground">{row.original.grantedBy}</span>
        </EmptyValue>
      ),
    },
    {
      header: '操作',
      meta: { width: 110 },
      cell: ({ row }) => (
        <ConfirmAction
          title="收回该主体的授权？运行中的工作区会删除对应技能目录。"
          onConfirm={() =>
            setMutation.mutate(
              current.filter(
                (item) =>
                  !(
                    item.principalType === row.original.principalType &&
                    item.principalId === row.original.principalId
                  ),
              ),
            )
          }
          danger
        >
          <IconText icon={<Trash2Icon />} size="small" danger>
            收回
          </IconText>
        </ConfirmAction>
      ),
    },
  ]

  return (
    <div className="h-full w-full overflow-auto p-4 sm:py-6">
      <DataTable<SkillGrantModel>
        title="技能授权"
        description="平台技能默认不可见；被授权的主体（用户 / 管理员 / 所有人）会在工作区里物化对应技能目录"
        toolbar={
          <>
            <RefreshButton
              loading={isFetching}
              onClick={() => (queryKey ? void refetch() : undefined)}
            />
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 px-2 transition-colors focus-within:ring-2 focus-within:ring-ring/40">
              <SearchIcon className="ml-0.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="技能 key（如 html-page）"
                value={skillKey}
                onChange={(event) => setSkillKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setQueryKey(skillKey.trim())
                }}
                className="h-7 w-52 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => setQueryKey(skillKey.trim())}
              disabled={skillKey.trim().length === 0}
            >
              查询
            </Button>
            <div className="flex items-center gap-1">
              <select
                value={principalType}
                onChange={(event) =>
                  setPrincipalType(event.target.value as 'user' | 'admin' | 'all')
                }
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              >
                {PRINCIPAL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <Input
                placeholder={principalType === 'all' ? '所有人（固定 *）' : '主体 id'}
                value={principalType === 'all' ? '*' : principalId}
                disabled={principalType === 'all'}
                onChange={(event) => setPrincipalId(event.target.value)}
                className="h-8 w-44"
              />
              <Button onClick={add} disabled={!queryKey || setMutation.isPending}>
                <PlusIcon />
                授权
              </Button>
            </div>
          </>
        }
        rowKey="id"
        loading={isFetching}
        columns={columns}
        data={data}
        emptyText={queryKey ? '这个技能还没有任何授权（只有超管可见）' : '先查询一个技能 key'}
      />
    </div>
  )
}
