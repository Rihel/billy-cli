'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { WorkspaceBackend, WorkspaceModel } from '@repo/shared'
import { Button, IconText, PageToolbar, Tag, toastError, toastSuccess } from '@repo/ui'
import {
  BoxesIcon,
  FolderOpenIcon,
  ShieldAlertIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  Trash2Icon,
  UserRoundIcon,
} from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import { CreateWorkspaceDialog } from '@/components/create-workspace-dialog'
import { WorkspaceFilesDialog } from './workspace-files-dialog'
import { useAuthStore } from '@/stores/auth.store'

const fail = (error: unknown): void =>
  toastError(error instanceof Error ? error.message : String(error))

const BACKEND_LABEL: Record<WorkspaceBackend, string> = {
  local: '本地',
  container: '容器',
  microvm: 'MicroVM',
}

/**
 * 工作区（`/main/ai/workspaces`）：AI 执行环境的控制面。
 *
 * 口径（见 `docs/design/workspace.md` §7）：
 * - 这里的「启动 / 停止」只写**期望状态**并调执行面；容器实际是否在跑看卡片上的实时标签；
 * - 每个管理员创建时自动有一条默认工作区，默认工作区不能删；
 * - 空闲 2 小时后执行面会回收容器（实际状态变化，不回写期望状态）。
 */
export default function WorkspacesPage() {
  const client = useServerClient()
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  /** 正在看文件的工作区（`null` = 弹窗关闭） */
  const [filesOf, setFilesOf] = useState<WorkspaceModel | null>(null)

  const { data = [], isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.workspace.list(),
  })
  // 部署级信息：沙箱关着的时候要显式提示（命令会以服务进程身份执行）
  const { data: serverInfo } = useQuery({
    queryKey: ['workspace-server-info'],
    queryFn: () => client.workspace.serverInfo(),
    staleTime: 60_000,
  })

  const invalidate = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ['workspaces'] })

  const start = useMutation({
    mutationFn: (id: string) => client.workspace.start({ id }),
    onSuccess: async () => {
      toastSuccess('已启动')
      await invalidate()
    },
    onError: fail,
  })

  const stop = useMutation({
    mutationFn: (id: string) => client.workspace.stop({ id }),
    onSuccess: async () => {
      toastSuccess('已停止')
      await invalidate()
    },
    onError: fail,
  })

  const remove = useMutation({
    mutationFn: (id: string) => client.workspace.remove({ id }),
    onSuccess: async () => {
      toastSuccess('已删除')
      await invalidate()
    },
    onError: fail,
  })

  const busy = start.isPending || stop.isPending || remove.isPending

  const sandboxOff =
    (serverInfo?.sandbox as { mode?: string } | undefined)?.mode === 'off' ||
    (serverInfo?.sandbox as { sandbox?: boolean } | undefined)?.sandbox === false
  // 沙箱开关只影响本机（host）工作区；全是容器工作区时提示没有意义，不显示
  const hasHostWorkspace = data.some((item) => item.driver === 'host' || item.backend === 'local')

  return (
    <div className="flex flex-col gap-4 p-4 sm:py-6">
      <PageToolbar
        title="工作区"
        description="AI 执行环境：会话在里面跑命令、读写文件。容器按需启动，空闲 2 小时后回收。"
        extra={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-4" />
            新建工作区
          </Button>
        }
      />
      {sandboxOff && hasHostWorkspace ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            <span className="font-medium text-foreground">命令沙箱已关闭</span>
            ：工作区里的命令会以服务进程身份执行，没有系统级隔离，仅建议自托管单机使用。
          </span>
        </div>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : data.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有工作区，点右上角新建一个。</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.map((item) => (
            <WorkspaceCard
              key={item.id}
              item={item}
              busy={busy}
              onStart={(id) => start.mutate(id)}
              onStop={(id) => stop.mutate(id)}
              onRemove={(id) => remove.mutate(id)}
              onFiles={() => setFilesOf(item)}
            />
          ))}
        </div>
      )}

      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={invalidate}
      />

      <WorkspaceFilesDialog client={client} workspace={filesOf} onClose={() => setFilesOf(null)} />
    </div>
  )
}

function WorkspaceCard({
  item,
  busy,
  onStart,
  onStop,
  onRemove,
  onFiles,
}: {
  item: WorkspaceModel
  busy: boolean
  onStart: (id: string) => void
  onStop: (id: string) => void
  onRemove: (id: string) => void
  /** 打开这个工作区的文件弹窗（未运行时入口禁用） */
  onFiles: () => void
}) {
  const me = useAuthStore((s) => s.adminInfo?.id)
  const running = item.runtime.state === 'running'
  const stateLabel = running
    ? '运行中'
    : item.desiredStatus === 'running'
      ? '启动中'
      : item.runtime.state === 'unknown'
        ? '不可用'
        : '已停止'
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BoxesIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{item.name}</span>
            {item.isDefault ? <Tag>默认</Tag> : null}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {BACKEND_LABEL[item.backend]} · {item.image ?? '默认镜像'} · {item.driver ?? '自动'} ·{' '}
            {item.fileAccess === 'write' ? '可写' : '只读'}
          </p>
          <p
            className="mt-0.5 truncate text-xs text-muted-foreground"
            title={item.root ?? undefined}
          >
            保存在：{item.root ?? '容器内 /workspace（临时）'}
          </p>
          {item.ownerId !== me ? (
            <div className="mt-1">
              <IconText
                icon={<UserRoundIcon />}
                size="small"
                tooltip={`所属用户：${item.ownerName ?? item.ownerId}`}
                aria-label={`所属用户：${item.ownerName ?? item.ownerId}`}
              />
            </div>
          ) : null}
        </div>
        <Tag>{stateLabel}</Tag>
      </div>
      <div className="mt-3 flex items-center gap-2">
        {running ? (
          <Button size="sm" variant="outline" onClick={() => onStop(item.id)} disabled={busy}>
            <SquareIcon className="size-3.5" />
            停止
          </Button>
        ) : (
          <Button size="sm" onClick={() => onStart(item.id)} disabled={busy}>
            <PlayIcon className="size-3.5" />
            启动
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={onFiles}
          disabled={busy || !running}
          title={running ? '查看工作区文件' : '工作区未运行，先启动再查看文件'}
        >
          <FolderOpenIcon className="size-3.5" />
          文件
        </Button>
        {item.isDefault ? null : (
          <Button size="sm" variant="ghost" onClick={() => onRemove(item.id)} disabled={busy}>
            <Trash2Icon className="size-3.5" />
            删除
          </Button>
        )}
      </div>
    </div>
  )
}
