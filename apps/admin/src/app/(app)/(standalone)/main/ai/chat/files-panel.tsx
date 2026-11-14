'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AgentFileModel, AgentFileNode, AgentWorkspaceFile } from '@repo/shared'
import { Badge, Button, cn } from '@repo/ui'
import { DownloadIcon, EyeIcon, FileIcon, FolderIcon, RefreshCwIcon } from 'lucide-react'
import type { ServerClient } from './data'
import { FilePreviewDialog, isPreviewTextItem, officeKind } from '@/components/file-preview-dialog'
import { formatFileSize } from './attachment-utils'

/**
 * 右栏「文件」tab（设计 `docs/design/ai-file-manager.md` §8.3）。
 *
 * 两个视图：
 * - 会话文件（OSS）：`aiFiles` 树，预览 / 下载；
 * - 工作区（临时）：`/agent/file/workspace` 扁平清单，前端组树，预览 / 下载 / 刷新。
 *
 * 两个视图不混在一棵树里：生命周期与动作不同（OSS 持久、工作区换 Pod 可能没了）。
 */
export function FilesPanel({
  client,
  conversationId,
  files,
}: {
  client: ServerClient
  conversationId?: string
  files: AgentFileNode[]
}) {
  const [view, setView] = useState<'session' | 'workspace'>('session')
  const [includeCaches, setIncludeCaches] = useState(false)
  const [preview, setPreview] = useState<{ items: PreviewTarget[]; index: number } | null>(null)

  const workspaceQuery = useQuery({
    queryKey: ['ai', 'workspace', conversationId ?? 'none', includeCaches],
    queryFn: () =>
      client.agent.file.workspace({
        conversationId: conversationId as string,
        includeCaches,
      }),
    enabled: Boolean(conversationId) && view === 'workspace',
  })

  const workspaceTree = useMemo(
    () => buildWorkspaceTree(workspaceQuery.data?.items ?? []),
    [workspaceQuery.data?.items],
  )

  const sessionFiles = useMemo(() => flattenSessionFiles(files), [files])
  const current = preview ? preview.items[preview.index] : null

  const textQuery = useQuery({
    queryKey: ['ai', 'file-preview', conversationId ?? 'none', current?.id ?? 'none'],
    queryFn: () =>
      client.agent.file.preview({
        conversationId: conversationId as string,
        path: current!.path,
        source: current!.source,
      }),
    enabled: Boolean(conversationId && current && isPreviewTextItem(current)),
  })

  /** 工作区文件先物化成临时 OSS 对象，再拿 inline / download 链接；不再让后端转发字节 */
  const workspaceUrl = async (target: PreviewTarget, download = false): Promise<string> => {
    const link = await client.agent.file.workspaceLink({
      conversationId: conversationId as string,
      path: target.path,
      download,
    })
    return link.url
  }

  const download = async (target: PreviewTarget): Promise<void> => {
    if (target.source === 'ai') {
      const { url } = await client.storage.getDownloadUrl({
        key: target.key!,
        filename: target.filename,
      })
      window.location.href = url
      return
    }
    if (!conversationId) return
    window.location.href = await workspaceUrl(target, true)
  }

  const openSession = (file: AgentFileModel) => {
    const items = sessionFiles.map(sessionTarget)
    setPreview({
      items,
      index: items.findIndex((item) => item.id === `ai:${file.path}`),
    })
  }
  const openWorkspace = (file: AgentWorkspaceFile) => {
    const items = (workspaceQuery.data?.items ?? []).map(workspaceTarget)
    setPreview({
      items,
      index: items.findIndex((item) => item.id === `workspace:${file.path}`),
    })
  }

  const previewItems = (preview?.items ?? []).map((target) => ({
    id: target.id,
    filename: target.filename,
    subtitle: target.source === 'ai' ? '会话文件' : '工作区',
    badge: target.badge,
    mediaType: target.mediaType,
    bytes: target.bytes,
    // 桶私有：二进制一律按需签短时地址；文本走 preview 接口，Office 走 loadBytes
    url: null,
    // 会话文件（OSS）签预签名 GET；工作区二进制先物化再直连；文本和 Office 走各自分支
    loadUrl:
      target.source === 'ai' && target.key && !isPreviewTextItem(target) && !officeKind(target)
        ? () =>
            client.storage
              .getDownloadUrl({ key: target.key!, filename: target.filename })
              .then((link) => link.url)
        : target.source === 'workspace' &&
            conversationId &&
            !isPreviewTextItem(target) &&
            !officeKind(target)
          ? () => workspaceUrl(target)
          : undefined,
    loadBytes: officeKind(target)
      ? async () => {
          const link =
            target.source === 'ai'
              ? await client.storage.getDownloadUrl({
                  key: target.key!,
                  filename: target.filename,
                })
              : await client.agent.file.workspaceLink({
                  conversationId: conversationId as string,
                  path: target.path,
                })
          const response = await fetch(link.url)
          if (!response.ok) throw new Error(`对象存储读取失败（HTTP ${response.status}）`)
          return response.arrayBuffer()
        }
      : undefined,
  }))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <div className="inline-flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={view === 'session'}
            className={cn(
              'h-7 rounded-md px-2.5',
              view === 'session'
                ? 'bg-surface-1 text-foreground shadow-sm hover:bg-surface-1'
                : 'text-muted-foreground',
            )}
            onClick={() => setView('session')}
          >
            会话文件
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={view === 'workspace'}
            className={cn(
              'h-7 rounded-md px-2.5',
              view === 'workspace'
                ? 'bg-surface-1 text-foreground shadow-sm hover:bg-surface-1'
                : 'text-muted-foreground',
            )}
            onClick={() => setView('workspace')}
          >
            工作区
          </Button>
        </div>
        {view === 'workspace' ? (
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setIncludeCaches((value) => !value)}>
              {includeCaches ? '隐藏缓存' : '显示缓存'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void workspaceQuery.refetch()}
              disabled={workspaceQuery.isFetching}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto pr-1">
        {view === 'session' ? (
          files.length === 0 ? (
            <Empty text="本会话还没有文件。发附件或 AI 提交后出现。" />
          ) : (
            <div className="flex flex-col gap-0.5">
              {files.map((node) => (
                <SessionNode
                  key={node.path}
                  node={node}
                  onPreview={openSession}
                  onDownload={(file) => void download(sessionTarget(file))}
                />
              ))}
            </div>
          )
        ) : workspaceQuery.isLoading ? (
          <Empty text="正在读取工作区…" />
        ) : workspaceQuery.isError ? (
          <Empty text="工作区读取失败（多副本部署下请以会话文件为准）" />
        ) : workspaceTree.length === 0 ? (
          <Empty text="工作区还没有文件。AI 写文件后出现。" />
        ) : (
          <div className="flex flex-col gap-0.5">
            {workspaceTree.map((node) => (
              <WorkspaceNode
                key={node.path}
                node={node}
                onPreview={openWorkspace}
                onDownload={(file) => void download(workspaceTarget(file))}
              />
            ))}
          </div>
        )}
      </div>

      <FilePreviewDialog
        items={previewItems}
        index={preview?.index ?? null}
        onIndexChange={(next) => setPreview((state) => (state ? { ...state, index: next } : state))}
        onClose={() => setPreview(null)}
        onDownload={(item) => {
          const target = preview?.items.find((candidate) => candidate.id === item.id)
          if (target) void download(target)
        }}
        text={textQuery.data?.text ?? null}
        loading={textQuery.isLoading}
      />
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full min-h-32 items-center justify-center px-6 text-center text-xs text-muted-foreground">
      {text}
    </div>
  )
}

function SessionNode({
  node,
  onPreview,
  onDownload,
}: {
  node: AgentFileNode
  onPreview: (file: AgentFileModel) => void
  onDownload: (file: AgentFileModel) => void
}) {
  if (node.type === 'dir') {
    return (
      <div>
        <div className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-muted-foreground">
          <FolderIcon className="size-3.5" />
          {node.name}
        </div>
        <div className="ml-3 border-l pl-2">
          {(node.children ?? []).map((child) => (
            <SessionNode
              key={child.path}
              node={child}
              onPreview={onPreview}
              onDownload={onDownload}
            />
          ))}
        </div>
      </div>
    )
  }
  const file = node.file
  if (!file) return null
  return (
    <FileRow
      name={file.filename}
      bytes={file.bytes}
      source={file.source}
      onPreview={() => onPreview(file)}
      onDownload={() => onDownload(file)}
    />
  )
}

type WorkspaceTreeNode = {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: WorkspaceTreeNode[]
  file?: AgentWorkspaceFile
}

function WorkspaceNode({
  node,
  onPreview,
  onDownload,
}: {
  node: WorkspaceTreeNode
  onPreview: (file: AgentWorkspaceFile) => void
  onDownload: (file: AgentWorkspaceFile) => void
}) {
  if (node.type === 'dir') {
    return (
      <div>
        <div className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-muted-foreground">
          <FolderIcon className="size-3.5" />
          {node.name}
        </div>
        <div className="ml-3 border-l pl-2">
          {(node.children ?? []).map((child) => (
            <WorkspaceNode
              key={child.path}
              node={child}
              onPreview={onPreview}
              onDownload={onDownload}
            />
          ))}
        </div>
      </div>
    )
  }
  const file = node.file
  if (!file) return null
  return (
    <FileRow
      name={node.name}
      bytes={file.bytes}
      onPreview={() => onPreview(file)}
      onDownload={() => onDownload(file)}
    />
  )
}

function FileRow({
  name,
  bytes,
  source,
  onPreview,
  onDownload,
}: {
  name: string
  bytes: number
  source?: 'user' | 'ai'
  onPreview: () => void
  onDownload: () => void
}) {
  return (
    // 行内含「下载」按钮，不能嵌套 <button>；整行可点按并已补键盘事件，保留 role=button
    <div
      role="button"
      tabIndex={0}
      title="点击预览"
      onClick={onPreview}
      onKeyDown={(event) => {
        // 事件从内部按钮冒上来时不要抢：否则在「下载」上按空格会变成预览
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onPreview()
        }
      }}
      className="group flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs">{name}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{formatFileSize(bytes)}</span>
      {source ? (
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {source === 'user' ? '用户上传' : 'AI 生成'}
        </Badge>
      ) : null}
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={(event) => {
          event.stopPropagation()
          onPreview()
        }}
        title="预览"
      >
        <EyeIcon className="size-3.5" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={(event) => {
          event.stopPropagation()
          onDownload()
        }}
        title="下载"
      >
        <DownloadIcon className="size-3.5" />
      </Button>
    </div>
  )
}

interface PreviewTarget {
  id: string
  source: 'ai' | 'workspace'
  path: string
  key?: string
  filename: string
  mediaType: string
  bytes: number
  title: string
  badge?: string
}

/** 会话文件树 → 当前预览队列（深度优先，与右栏顺序一致） */
function flattenSessionFiles(nodes: readonly AgentFileNode[]): AgentFileModel[] {
  const result: AgentFileModel[] = []
  const walk = (list: readonly AgentFileNode[]) => {
    for (const node of list) {
      if (node.type === 'dir') {
        walk(node.children ?? [])
      } else if (node.file) {
        result.push(node.file)
      }
    }
  }
  walk(nodes)
  return result
}

const sessionTarget = (file: AgentFileModel): PreviewTarget => ({
  id: `ai:${file.path}`,
  source: 'ai',
  path: file.path,
  key: file.key,
  filename: file.filename,
  mediaType: file.mediaType,
  bytes: file.bytes,
  title: file.filename,
  badge: file.source === 'user' ? '用户上传' : 'AI 生成',
})

const workspaceTarget = (file: AgentWorkspaceFile): PreviewTarget => ({
  id: `workspace:${file.path}`,
  source: 'workspace',
  path: file.path,
  filename: file.path.split('/').pop() ?? file.path,
  mediaType: mediaTypeOf(file.path),
  bytes: file.bytes,
  title: file.path,
  badge: '工作区',
})

const extOf = (filename: string): string => {
  const base = filename.split('/').pop() ?? filename
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index + 1).toLowerCase() : ''
}

const mediaTypeOf = (filename: string): string => {
  const ext = extOf(filename)
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
    htm: 'text/html',
    json: 'application/json',
    csv: 'text/csv',
  }
  return map[ext] ?? 'application/octet-stream'
}

function buildWorkspaceTree(items: AgentWorkspaceFile[]): WorkspaceTreeNode[] {
  const root: WorkspaceTreeNode[] = []
  const dirs = new Map<string, WorkspaceTreeNode>()
  for (const file of items) {
    const segments = file.path.split('/').filter(Boolean)
    let list = root
    let acc = ''
    for (let index = 0; index < segments.length - 1; index += 1) {
      acc = acc ? `${acc}/${segments[index]}` : segments[index]
      let dir = dirs.get(acc)
      if (!dir) {
        dir = { name: segments[index], path: acc, type: 'dir', children: [] }
        dirs.set(acc, dir)
        list.push(dir)
      }
      list = dir.children!
    }
    list.push({
      name: segments[segments.length - 1] ?? file.path,
      path: file.path,
      type: 'file',
      file,
    })
  }
  const sort = (nodes: WorkspaceTreeNode[]): void => {
    nodes.sort((left, right) =>
      left.type === right.type
        ? left.name.localeCompare(right.name, 'zh-Hans-CN')
        : left.type === 'dir'
          ? -1
          : 1,
    )
    for (const node of nodes) if (node.children) sort(node.children)
  }
  sort(root)
  return root
}
