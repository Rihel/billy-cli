'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { SkillSource } from '@repo/shared'
import type {
  AiSkillCreateDto,
  AiSkillImportDto,
  AiSkillImportPreviewResultModel,
  AiSkillImportResultModel,
  AiSkillModel,
} from '@repo/shared'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  DataTable,
  DictSelect,
  Input,
  Label,
  RefreshButton,
  Switch,
  toastError,
  toastSuccess,
} from '@repo/ui'
import { InfoIcon, LinkIcon, PlusIcon, SearchIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import { CreateSkillDialog } from './create-skill-dialog'
import { ImportSkillDialog } from './import-skill-dialog'
import { buildSkillColumns } from './skill-columns'

/**
 * 技能库（`/main/ai/skills`）—— 在线编辑 / 从链接导入 / 启停治理。
 *
 * 页面口径（也写在页面里，避免"为什么改了没生效"这类问题）：
 * 1. **DB 是事实源**：保存后服务端落盘给运行时读，不需要重启；
 * 2. **启停立即生效**：停用会删掉落盘目录，模型立刻看不到；
 * 3. **技能内容是指令**：会被注入上下文，所以写入入口只有后台管理员（agent 工具的作用域也是 admin）。
 */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export default function SkillsPage() {
  const client = useServerClient()
  const router = useRouter()

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [keyword, setKeyword] = useState<string | undefined>()
  const [searchText, setSearchText] = useState('')
  const [source, setSource] = useState<string | null>(null)
  const [onlyEnabled, setOnlyEnabled] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importPreview, setImportPreview] = useState<AiSkillImportPreviewResultModel | null>(null)
  const [importResult, setImportResult] = useState<AiSkillImportResultModel | null>(null)

  const listQuery = useQuery({
    queryKey: ['aiSkill', 'list', { page, pageSize, keyword, source, onlyEnabled }],
    queryFn: () =>
      client.aiSkill.list({
        page,
        size: pageSize,
        keyword,
        source: source ?? undefined,
        enabled: onlyEnabled ? true : undefined,
      }),
  })

  const refetch = listQuery.refetch

  const createMutation = useMutation({
    mutationFn: (dto: AiSkillCreateDto) => client.aiSkill.create(dto),
  })
  const updateMutation = useMutation({
    mutationFn: (input: { skillKey: string; enabled: boolean }) =>
      client.aiSkill.update(input),
  })
  const removeMutation = useMutation({
    mutationFn: (skillKey: string) => client.aiSkill.remove({ skillKey }),
  })
  const previewMutation = useMutation({
    mutationFn: (url: string) => client.aiSkill.previewImport({ url }),
  })
  const importMutation = useMutation({
    mutationFn: (dto: AiSkillImportDto) => client.aiSkill.import(dto),
  })

  const saving = updateMutation.isPending || removeMutation.isPending

  const handleCreate = async (dto: AiSkillCreateDto): Promise<void> => {
    try {
      await createMutation.mutateAsync(dto)
      toastSuccess(`已创建技能「${dto.skillKey}」`, '正在打开编辑器；补上"何时用"、写完正文保存即可')
      setCreateOpen(false)
      void refetch()
      router.push(`/main/ai/skills/${encodeURIComponent(dto.skillKey)}`)
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const handleToggleEnabled = (skill: AiSkillModel, enabled: boolean): void => {
    updateMutation.mutate(
      { skillKey: skill.skillKey, enabled },
      {
        onSuccess: () => {
          toastSuccess(
            enabled ? `已启用「${skill.skillKey}」` : `已停用「${skill.skillKey}」`,
            enabled ? '已落盘，模型下一轮可见' : '已从落盘目录移除，模型立刻看不到',
          )
          void refetch()
        },
        onError: (error) => toastError(messageOf(error)),
      },
    )
  }

  const handleRemove = async (skill: AiSkillModel): Promise<void> => {
    try {
      await removeMutation.mutateAsync(skill.skillKey)
      toastSuccess(`已删除「${skill.skillKey}」`, '落盘目录已一并移除')
      void refetch()
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const handlePreview = async (url: string): Promise<void> => {
    try {
      setImportResult(null)
      setImportPreview(await previewMutation.mutateAsync(url))
    } catch (error) {
      setImportPreview(null)
      toastError(messageOf(error))
    }
  }

  const handleImport = async (dto: AiSkillImportDto): Promise<void> => {
    try {
      const result = await importMutation.mutateAsync(dto)
      setImportResult(result)
      const failed = result.items.filter((item) => item.status === 'failed').length
      if (failed > 0) toastError(`导入完成：${result.total - failed} 个成功，${failed} 个失败`)
      else toastSuccess(`导入完成`, `共 ${result.total} 个技能`)
      void refetch()
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const columns = buildSkillColumns({
    saving,
    onOpen: (skill) => router.push(`/main/ai/skills/${encodeURIComponent(skill.skillKey)}`),
    onToggleEnabled: handleToggleEnabled,
    onRemove: handleRemove,
  })

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4 sm:py-6">
      <DataTable<AiSkillModel>
        title="技能库"
        description="在线写 / 从链接装 / 启停即生效；这里启用的技能会出现在 agent 的可用技能清单里"
        toolbar={
          <>
            <RefreshButton loading={listQuery.isFetching} onClick={() => void refetch()} />
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 px-2 transition-colors focus-within:ring-2 focus-within:ring-ring/40">
              <SearchIcon className="ml-0.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="搜索技能名 / 标题..."
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
              dict={SkillSource}
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
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setImportResult(null)
                setImportPreview(null)
                setImportOpen(true)
              }}
            >
              <LinkIcon />
              从链接导入
            </Button>
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              新建技能
            </Button>
          </>
        }
        rowKey="skillKey"
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
        emptyText="还没有技能：点「新建技能」直接写，或「从链接导入」从 skills.sh / GitHub 装一个"
      />

      <CreateSkillDialog
        open={createOpen}
        saving={createMutation.isPending}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreate}
      />

      <ImportSkillDialog
        open={importOpen}
        busy={previewMutation.isPending || importMutation.isPending}
        previewing={previewMutation.isPending}
        preview={importPreview}
        result={importResult}
        onClose={() => setImportOpen(false)}
        onPreview={handlePreview}
        onImport={handleImport}
      />

      <details className="shrink-0 rounded-xl bg-surface-1 px-4 py-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          口径说明（3 条）
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          <Alert>
            <InfoIcon />
            <AlertTitle>库是事实源，目录是投影</AlertTitle>
            <AlertDescription>
              保存时先写库，再把技能落盘成一个目录（Mastra 只认目录）。落盘失败会报错，重启服务会自动修复。
              导入也一样：**下载内容进库**，不是登记一个链接。
            </AlertDescription>
          </Alert>
          <Alert>
            <InfoIcon />
            <AlertTitle>启停立即生效</AlertTitle>
            <AlertDescription>
              停用会同时删掉落盘目录，模型的技能清单与 <code>skill_read</code> 立刻看不到它；
              内容仍在库里，随时能再启用。
            </AlertDescription>
          </Alert>
          <Alert>
            <InfoIcon />
            <AlertTitle>技能内容会进入模型上下文</AlertTitle>
            <AlertDescription>
              技能正文是指令，所以写入入口只对管理员开放；agent 的 <code>skill-save</code> 工具作用域也是
              admin，普通前台用户不能借对话写库。
            </AlertDescription>
          </Alert>
        </div>
      </details>
    </div>
  )
}
