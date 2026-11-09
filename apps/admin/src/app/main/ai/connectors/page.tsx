'use client'

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type {
  AiConnectorCreateDto,
  AiConnectorModel,
  AiConnectorUpdateDto,
} from '@repo/shared'
import { Alert, AlertDescription, AlertTitle, DataTable, Input, RefreshButton, toastError, toastSuccess } from '@repo/ui'
import { InfoIcon, PlusIcon, SearchIcon } from 'lucide-react'
import { Button } from '@repo/ui'
import { useServerClient } from '@/lib/server-client'
import { buildConnectorColumns } from './connector-columns'
import { ConnectorFormModal } from './connector-form'

/**
 * 连接器（`/main/ai/connectors`）—— 外部能力来源：地址 + 凭证 + 状态。
 *
 * 页面口径（也写在页面里，避免"为什么不同步就看不到工具"这类问题）：
 * 1. **测试只验证连通**：不产生工具，只写「上次测试」的结论；
 * 2. **同步才会产出工具**：它把对方的能力登记进 `ai_tools`，然后模型那一轮就能看到；
 * 3. **停用立刻生效**：不用重启，但工具行还在（历史对话引用着 key）。
 */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export default function ConnectorsPage() {
  const client = useServerClient()

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [keyword, setKeyword] = useState<string | undefined>()
  const [searchText, setSearchText] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<AiConnectorModel | null>(null)

  const listQuery = useQuery({
    queryKey: ['aiConnector', 'list', { page, pageSize, keyword }],
    queryFn: () => client.aiConnector.list({ page, size: pageSize, keyword }),
  })

  const catalogQuery = useQuery({
    queryKey: ['aiConnector', 'catalog'],
    queryFn: () => client.aiConnector.catalog(),
  })

  const refetch = listQuery.refetch

  const createMutation = useMutation({
    mutationFn: (dto: AiConnectorCreateDto) => client.aiConnector.create(dto),
  })
  const updateMutation = useMutation({
    mutationFn: (dto: AiConnectorUpdateDto) => client.aiConnector.update(dto),
  })
  const testMutation = useMutation({
    mutationFn: (id: string) => client.aiConnector.test({ id }),
  })
  const syncMutation = useMutation({
    mutationFn: (id: string) => client.aiConnector.sync({ id }),
  })
  const removeMutation = useMutation({
    mutationFn: (id: string) => client.aiConnector.remove({ id }),
  })

  const saving =
    createMutation.isPending ||
    updateMutation.isPending ||
    testMutation.isPending ||
    syncMutation.isPending ||
    removeMutation.isPending

  const handleCreate = async (dto: AiConnectorCreateDto): Promise<void> => {
    try {
      await createMutation.mutateAsync(dto)
      toastSuccess('已创建连接器', '下一步点「测试」验证连通，再点「同步」产出工具')
      setFormOpen(false)
      void refetch()
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const handleUpdate = async (dto: AiConnectorUpdateDto): Promise<void> => {
    try {
      await updateMutation.mutateAsync(dto)
      toastSuccess('已保存', '改了地址 / 凭证后建议重新「测试」与「同步」')
      setFormOpen(false)
      void refetch()
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const handleToggleEnabled = (row: AiConnectorModel, enabled: boolean): void => {
    updateMutation.mutate(
      { id: row.id, enabled },
      {
        onSuccess: () => {
          toastSuccess(enabled ? `已启用「${row.name}」` : `已停用「${row.name}」`)
          void refetch()
        },
        onError: (error) => toastError(messageOf(error)),
      },
    )
  }

  const handleTest = async (row: AiConnectorModel): Promise<void> => {
    const result = await testMutation.mutateAsync(row.id).catch((error: unknown) => {
      toastError(messageOf(error))
      return null
    })
    if (!result) return
    if (result.ok) toastSuccess(`「${row.name}」连接正常`)
    else toastError(result.message ?? '连接失败')
    void refetch()
  }

  const handleSync = async (row: AiConnectorModel): Promise<void> => {
    const result = await syncMutation.mutateAsync(row.id).catch((error: unknown) => {
      toastError(messageOf(error))
      return null
    })
    if (!result) return
    if (result.ok) {
      toastSuccess(`已同步「${row.name}」`, `登记了 ${result.toolCount ?? 0} 个工具`)
    } else {
      toastError(result.message ?? '同步失败')
    }
    void refetch()
  }

  const handleRemove = async (row: AiConnectorModel): Promise<void> => {
    try {
      await removeMutation.mutateAsync(row.id)
      toastSuccess(`已删除「${row.name}」`, '它产出的工具已全部停用')
      void refetch()
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const columns = buildConnectorColumns({
    saving,
    onEdit: (row) => {
      setEditing(row)
      setFormOpen(true)
    },
    onToggleEnabled: handleToggleEnabled,
    onTest: handleTest,
    onSync: handleSync,
    onRemove: handleRemove,
  })

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4 sm:py-6">
      <DataTable<AiConnectorModel>
        title="连接器"
        description="外部能力来源：填好地址与凭证，同步后它的工具才会出现在模型手上"
        toolbar={
          <>
            <RefreshButton loading={listQuery.isFetching} onClick={() => void refetch()} />
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 px-2 transition-colors focus-within:ring-2 focus-within:ring-ring/40">
              <SearchIcon className="ml-0.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="搜索 key..."
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
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setEditing(null)
                setFormOpen(true)
              }}
            >
              <PlusIcon />
              新建连接器
            </Button>
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
        emptyText="还没有连接器：点「新建连接器」，先接一个 PostgreSQL / MySQL / Redis"
      />

      <Alert>
        <InfoIcon />
        <AlertTitle>三个动作的区别</AlertTitle>
        <AlertDescription>
          测试 = 只验证连不连得上（会写「上次测试」的状态）；同步 = 把对方的能力登记成工具（这一步之后模型才看得到）；
          停用 = 立刻不可调，工具行保留。
        </AlertDescription>
      </Alert>

      <ConnectorFormModal
        open={formOpen}
        catalog={catalogQuery.data ?? []}
        editing={editing}
        saving={saving}
        onClose={() => setFormOpen(false)}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
      />
    </div>
  )
}
