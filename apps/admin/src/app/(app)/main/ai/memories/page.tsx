'use client'

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AiMemoryKind } from '@repo/shared'
import type { AiMemoryModel, AiMemoryUpdateDto } from '@repo/shared'
import {
  DataTable,
  DictSelect,
  Input,
  Label,
  RefreshButton,
  Switch,
  toastError,
  toastSuccess,
} from '@repo/ui'
import { SearchIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import { buildMemoryColumns } from './memory-columns'
import { MemoryEditDialog } from './memory-edit-dialog'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * 记忆（`/main/ai/memories`）—— 长期记忆的查看与治理。
 *
 * 三条口径：
 * 1. **按用户归属**：agent 只能读写当前登录用户的记忆，这里管理员可以跨用户查看；
 * 2. **启停与置顶立即生效**：下一轮组装上下文时按新状态算，不用重启；
 * 3. **软删不丢证据**：删掉的条目不再注入，数据仍在库里。
 */
export default function MemoriesPage() {
  const client = useServerClient()

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [keyword, setKeyword] = useState<string | undefined>()
  const [searchText, setSearchText] = useState('')
  const [kind, setKind] = useState<string | null>(null)
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  const [editing, setEditing] = useState<AiMemoryModel | null>(null)

  const listQuery = useQuery({
    queryKey: ['aiMemory', 'list', { page, pageSize, keyword, kind, onlyEnabled }],
    queryFn: () =>
      client.aiMemory.list({
        page,
        size: pageSize,
        keyword,
        ...(kind ? { kind: kind as AiMemoryUpdateDto['kind'] } : {}),
        enabled: onlyEnabled ? true : undefined,
      }),
  })

  const refetch = listQuery.refetch

  const updateMutation = useMutation({
    mutationFn: (input: AiMemoryUpdateDto) => client.aiMemory.update(input),
  })
  const removeMutation = useMutation({
    mutationFn: (id: string) => client.aiMemory.remove({ id }),
  })

  const saving = updateMutation.isPending || removeMutation.isPending

  const handleToggle = (
    memory: AiMemoryModel,
    patch: { enabled?: boolean; pinned?: boolean },
  ): void => {
    updateMutation.mutate(
      { id: memory.id, ...patch },
      {
        onSuccess: () => {
          if (patch.enabled !== undefined) {
            toastSuccess(
              patch.enabled ? '已启用' : '已停用',
              patch.enabled ? '下一轮开始注入' : '下一轮起不再注入',
            )
          } else if (patch.pinned !== undefined) {
            toastSuccess(patch.pinned ? '已置顶' : '已取消置顶')
          }
          void refetch()
        },
        onError: (error) => toastError(messageOf(error)),
      },
    )
  }

  const handleSave = async (input: AiMemoryUpdateDto): Promise<void> => {
    try {
      await updateMutation.mutateAsync(input)
      toastSuccess('已保存', '下一轮对话生效')
      setEditing(null)
      void refetch()
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const handleRemove = async (memory: AiMemoryModel): Promise<void> => {
    try {
      await removeMutation.mutateAsync(memory.id)
      toastSuccess('已删除', '下一轮起不再注入')
      void refetch()
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const columns = buildMemoryColumns({
    saving,
    onEdit: setEditing,
    onToggle: handleToggle,
    onRemove: handleRemove,
  })

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4 sm:py-6">
      <DataTable<AiMemoryModel>
        title="记忆"
        description="长期记忆按用户归属、跨会话生效；这里可以查看、编辑、停用与删除"
        toolbar={
          <>
            <RefreshButton loading={listQuery.isFetching} onClick={() => void refetch()} />
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 px-2 transition-colors focus-within:ring-2 focus-within:ring-ring/40">
              <SearchIcon className="ml-0.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="搜索记忆内容..."
                value={searchText}
                onChange={(event) => {
                  setSearchText(event.target.value)
                  if (event.target.value === '') {
                    setKeyword(undefined)
                    setPage(1)
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    setKeyword(searchText.trim() || undefined)
                    setPage(1)
                  }
                }}
                className="h-7 w-48 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
              />
            </div>
            <DictSelect
              dict={AiMemoryKind}
              value={kind}
              allowClear
              placeholder="全部类型"
              onValueChange={(next) => {
                setKind(next)
                setPage(1)
              }}
            />
            <Label className="gap-2 text-xs font-normal text-muted-foreground">
              <Switch
                checked={onlyEnabled}
                aria-label="只看已启用"
                onCheckedChange={(checked) => {
                  setOnlyEnabled(checked === true)
                  setPage(1)
                }}
              />
              只看已启用
            </Label>
          </>
        }
        rowKey="id"
        loading={listQuery.isFetching}
        columns={columns}
        data={listQuery.data?.items}
        page={page}
        pageSize={pageSize}
        total={listQuery.data?.total}
        onPageChange={(nextPage, nextPageSize) => {
          setPage(nextPage)
          setPageSize(nextPageSize)
        }}
        emptyText="还没有记忆：用户在对话里说过「以后都按这个来」之类的稳定信息后，agent 会自动记下来"
      />

      <MemoryEditDialog
        memory={editing}
        saving={updateMutation.isPending}
        onClose={() => setEditing(null)}
        onSave={handleSave}
      />
    </div>
  )
}
