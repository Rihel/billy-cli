'use client'

import dedent from 'dedent'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ToolCategory, ToolSource } from '@repo/shared'
import type { AiToolModel, AiToolUpdateDto } from '@repo/shared'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  DataTable,
  DictSelect,
  Input,
  RefreshButton,
  Switch,
  toastSuccess,
  useDisclosure,
  Label,
} from '@repo/ui'
import { BanIcon, HistoryIcon, InfoIcon, SearchIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import { buildToolColumns } from './tool-columns'
import { ToolFormModal } from './tool-form'

/**
 * AI 工具配置（`/main/ai/tools`）—— 工具清单 + 治理开关 + 工具专属配置。
 *
 * 页面的三条口径（都在列表上方如实写出来，因为它决定了"改了看到的效果"）：
 * 1. **改完不需要重启**：配置经 `/ai-tool/update` 入库，下一次工具调用生效；
 * 2. **工具面是装配期快照**：关掉工具后提示词里仍列着它，只是调用会被拒；
 * 3. **runtime 工具只读**：Mastra 自带的技能工具不受开关与限额控制。
 *
 * 本页只管"清单 + 查询 + 行内启停"，编辑表单在 `tool-form.tsx`、工具专属配置面板在
 * `config-panels.tsx`、列定义在 `tool-columns.tsx`、入参构建在 `tool-payload.ts`。
 */
export default function AiToolsPage() {
  const client = useServerClient()

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [keyword, setKeyword] = useState<string | undefined>()
  const [searchText, setSearchText] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [onlyEnabled, setOnlyEnabled] = useState(false)

  const editDialog = useDisclosure<AiToolModel>()

  const toolsQuery = useQuery({
    queryKey: ['aiTool', 'list', { page, pageSize, keyword, category, source, onlyEnabled }],
    queryFn: () =>
      client.aiTool.list({
        page,
        size: pageSize,
        keyword,
        category: category ?? undefined,
        source: source ?? undefined,
        enabled: onlyEnabled ? true : undefined,
      }),
  })

  const refetch = toolsQuery.refetch

  const updateMutation = useMutation({
    mutationFn: (input: AiToolUpdateDto) => client.aiTool.update(input),
  })

  const resetMutation = useMutation({
    mutationFn: (input: { toolKey: string }) => client.aiTool.reset(input),
  })

  /** 行内启停：只提交 `{ toolKey, enabled }`，其余字段一律不动 */
  const handleToggleEnabled = (tool: AiToolModel, enabled: boolean) => {
    updateMutation.mutate(
      { toolKey: tool.toolKey, enabled },
      {
        onSuccess: () => {
          toastSuccess(enabled ? `已启用「${tool.title}」` : `已停用「${tool.title}」`)
          void refetch()
        },
      },
    )
  }

  /** 保存（表单只带改动过的字段；请求失败由全局 mutation 错误 toast 兜底） */
  const handleSave = async (dto: AiToolUpdateDto): Promise<void> => {
    await updateMutation.mutateAsync(dto)
    toastSuccess('工具配置已更新', '下一次工具调用生效，不需要重启')
    void refetch()
  }

  /** 恢复默认：清掉人工覆盖与已配秘钥，来源回「代码声明」 */
  const handleReset = async (tool: AiToolModel): Promise<void> => {
    await resetMutation.mutateAsync({ toolKey: tool.toolKey })
    toastSuccess('已恢复默认', tool.toolKey)
    void refetch()
  }

  const columns = buildToolColumns({
    saving: updateMutation.isPending || resetMutation.isPending,
    onToggleEnabled: handleToggleEnabled,
    onEdit: (tool) => editDialog.open(tool),
    onReset: handleReset,
  })

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4 sm:py-6">
      <DataTable<AiToolModel>
        title="AI 工具配置"
        description="开关、作用域、限额与专属配置；这份清单与模型看到的工具面一致"
        toolbar={
          <>
            <RefreshButton
              loading={toolsQuery.isFetching}
              onClick={() => void refetch()}
            />
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 px-2 transition-colors focus-within:ring-2 focus-within:ring-ring/40">
              <SearchIcon className="ml-0.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="搜索工具 key / 标题..."
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
              dict={ToolCategory}
              value={category}
              allowClear
              placeholder="全部类别"
              onValueChange={(next) => {
                setCategory(next)
                setPage(1)
              }}
            />
            <DictSelect
              dict={ToolSource}
              value={source}
              allowClear
              placeholder="全部来源"
              onValueChange={(next) => {
                setSource(next)
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
        rowKey="toolKey"
        loading={toolsQuery.isFetching}
        columns={columns}
        data={toolsQuery.data?.items}
        page={page}
        pageSize={pageSize}
        total={toolsQuery.data?.total}
        onPageChange={(nextPage, nextPageSize) => {
          setPage(nextPage)
          setPageSize(nextPageSize)
        }}
        emptyText="没有匹配的工具：换个筛选条件；要加新工具得先在代码里声明它"
      />

      <ToolFormModal
        tool={editDialog.data ?? null}
        open={editDialog.isOpen}
        saving={updateMutation.isPending || resetMutation.isPending}
        onSave={handleSave}
        onReset={handleReset}
        onClose={editDialog.close}
      />

      {/* 辅助：口径说明默认折叠 —— 它是参考材料，不该占主内容的位置 */}
      <details className="shrink-0 rounded-xl bg-surface-1 px-4 py-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          配置口径说明（3 条）
        </summary>
        <div className="mt-3 flex flex-col gap-2">
                    <Alert>
            <InfoIcon />
            <AlertTitle>改完不需要重启</AlertTitle>
            <AlertDescription>
              配置保存后下一次工具调用就生效，不用重启服务；已经在跑的那一轮不受影响。
            </AlertDescription>
          </Alert>
          <Alert>
            <BanIcon />
            <AlertTitle>工具面是装配期快照</AlertTitle>
            <AlertDescription>
              关掉一个工具后，模型的提示词里仍然列着它 —— 快照在装配期就算好了。
              区别是调用会被拒（结论落在时间线上），不是"模型看不见它"。
            </AlertDescription>
          </Alert>
          <Alert>
            <HistoryIcon />
            <AlertTitle>runtime 类别不受开关与限额控制</AlertTitle>
            <AlertDescription>
              {dedent`
                runtime 类别是 Mastra 自带的技能工具（skill / skill_search / skill_read）：
                它们包装配期就挂上了，网关拦不到，所以开关与限额对它们无效，后台只能查看。
              `}
            </AlertDescription>
          </Alert>
      
        </div>
      </details>
    </div>
  )
}
