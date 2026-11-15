'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AgentFileModel, AgentFileNode, AgentWorkspaceFile } from '@repo/shared'
import { Badge, Button, cn, DataList } from '@repo/ui'
import {
  ChevronDownIcon,
  DownloadIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  RefreshCwIcon,
} from 'lucide-react'
import type { ServerClient } from './data'
import { FilePreviewDialog, isPreviewTextItem, officeKind } from '@/components/file-preview-dialog'
import { formatFileSize } from './attachment-utils'

/**
 * 右栏的**文件树面板**（设计 `docs/design/ai-file-manager.md` §8.3）。
 *
 * 两个视图各自是**顶层 tab**（`right-panel.tsx`：文件 / 工作区），这里只负责渲染其中一个：
 * - `view='session'` 会话文件（OSS）：`aiFiles` 树，预览 / 下载；
 * - `view='workspace'` 工作区（临时）：`/agent/file/workspace` 扁平清单，前端组树，预览 / 下载 / 刷新。
 *
 * 两个视图不混在一棵树里：生命周期与动作不同（OSS 持久、工作区换 Pod 可能没了）。
 * 拆成两个 tab 而不是一个 tab 里分段切换：两者是不同的东西（来源、持久性、清理时机都不同），
 * 放平级更像"两个入口"而不是"一个东西的两种看法"。
 */
export function FilesPanel({
  client,
  conversationId,
  files,
  view,
}: {
  client: ServerClient
  conversationId?: string
  files: AgentFileNode[]
  view: 'session' | 'workspace'
}) {
  const [includeCaches, setIncludeCaches] = useState(false)
  const [preview, setPreview] = useState<{ items: PreviewTarget[]; index: number } | null>(null)
  /**
   * 目录折叠状态：只存「收起了哪些」，空集合 = 全部展开。
   *
   * 两个视图现在是两个独立 tab（各自一个 `FilesPanel` 实例），所以不需要再按视图分两份记。
   * 不持久化：切 tab / 刷新 / 换会话都回到全展开 —— 「看不到就重新找」比记住一个隐藏状态更安全。
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  /**
   * 工作区清单：**一次拿全量一维数组**，树在前端拼。
   *
   * 为什么不分页：树是给人看的，半加载的树会让人以为文件少了，翻页按钮压在一棵树下面也不好用；
   * 服务端已经把依赖 / 构建 / 缓存目录（`node_modules` / `.git` / `dist` …）排除掉，剩下的条目量
   * 在正常使用下很小。模型工具 `workspace-files` 才分页 —— 那边是 token 预算问题。
   */
  const workspaceQuery = useQuery({
    queryKey: ['ai', 'workspace', conversationId ?? 'none', includeCaches],
    queryFn: () =>
      client.agent.file.workspace({
        conversationId: conversationId as string,
        includeCaches,
      }),
    enabled: Boolean(conversationId) && view === 'workspace',
  })

  const workspaceItems = useMemo(
    () => workspaceQuery.data?.items ?? [],
    [workspaceQuery.data?.items],
  )
  /** 某页报告过「深度上限截断」：深层文件不在列表里，要如实说一句 */
  const depthLimited = workspaceQuery.data?.depthLimited ?? false

  const workspaceTree = useMemo(() => buildWorkspaceTree(workspaceItems), [workspaceItems])
  /**
   * 工作区树 → **当前可见行**（折叠的子树整段不出现）。
   *
   * 虚拟滚动只接受一维数组，所以树必须在渲染前拍平；折叠状态参与拍平，
   * 这样「收起」就是真的少行，而不是渲染出来再 CSS 隐藏。
   */
  const workspaceRows = useMemo(
    () => flattenWorkspaceRows(workspaceTree, collapsed),
    [workspaceTree, collapsed],
  )

  const sessionFiles = useMemo(() => flattenSessionFiles(files), [files])
  const current = preview ? preview.items[preview.index] : null

  // 当前视图的目录集合（折叠交互两个视图共用，只是数据源不同）
  const sessionDirPaths = useMemo(() => collectSessionDirPaths(files), [files])
  const workspaceDirPaths = useMemo(() => collectDirPaths(workspaceTree), [workspaceTree])
  const dirPaths = view === 'session' ? sessionDirPaths : workspaceDirPaths
  /** 全部收起：按钮这时反过来提供「全部展开」；点一次就能从深目录里退出来 */
  const allCollapsed = dirPaths.length > 0 && dirPaths.every((path) => collapsed.has(path))

  const toggleDir = (path: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const toggleAllDirs = (): void => {
    setCollapsed(allCollapsed ? new Set<string>() : new Set(dirPaths))
  }

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
    const items = workspaceItems.map(workspaceTarget)
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
      {/* 右栏最窄 260px：显示缓存 + 刷新 + 全部收起 一行可能放不下，允许折行而不是被裁掉 */}
      <div className="flex flex-wrap items-center gap-1.5">
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
        {/* 有目录才给「全部展开 / 收起」：树里全是文件时这个按钮没有意义 */}
        {dirPaths.length > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className={cn('h-7 shrink-0', view === 'session' && 'ml-auto')}
            onClick={toggleAllDirs}
            title={allCollapsed ? '展开所有目录' : '收起所有目录'}
          >
            {allCollapsed ? '全部展开' : '全部收起'}
          </Button>
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
                  collapsed={collapsed}
                  onToggle={toggleDir}
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
        ) : workspaceRows.length === 0 ? (
          <Empty text="工作区还没有文件。AI 写文件后出现。" />
        ) : (
          // 外层滚动区是 block（不是 flex），所以这里用 h-full 拿到确定高度：
          // Virtuoso 的 `height: 100%` 需要一个有确定高度的父容器，否则高度算成 0、一行都不渲染
          <div className="flex h-full min-h-0 flex-col gap-1">
            {/* 深度截断不是分页：文件真的在更深的目录里没被列出，要如实说 */}
            {depthLimited ? (
              <p className="shrink-0 px-1.5 text-[11px] leading-4 text-muted-foreground">
                部分文件在更深的目录里，超出读取深度，未列出。
              </p>
            ) : null}
            {/*
              虚拟滚动：树先拍平成「当前可见行」（折叠的子树不进行），再把行交给 Virtuoso 只渲染窗口内那几十行。
              文件依然是**全量**的（不回到分页）—— 只是 DOM 按需挂载，几万个文件也不卡。
            */}
            <DataList<WorkspaceRow>
              className="min-h-0 flex-1"
              height="100%"
              dataSource={workspaceRows}
              rowKey={(row) => row.path}
              renderItem={(row) => (
                <WorkspaceRowView
                  row={row}
                  collapsed={collapsed}
                  onToggle={toggleDir}
                  onPreview={openWorkspace}
                  onDownload={(file) => void download(workspaceTarget(file))}
                />
              )}
            />
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
  collapsed,
  onToggle,
  onPreview,
  onDownload,
}: {
  node: AgentFileNode
  collapsed: ReadonlySet<string>
  onToggle: (path: string) => void
  onPreview: (file: AgentFileModel) => void
  onDownload: (file: AgentFileModel) => void
}) {
  if (node.type === 'dir') {
    const open = !collapsed.has(node.path)
    const children = node.children ?? []
    return (
      <div>
        {/* 目录行是纯折叠开关（没有嵌套按钮），所以用真正的 <button>，键盘与读屏都天然可用 */}
        <button
          type="button"
          aria-expanded={open}
          title={open ? '收起' : '展开'}
          onClick={() => onToggle(node.path)}
          className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronDownIcon
            className={cn('size-3.5 shrink-0 transition-transform', !open && '-rotate-90')}
          />
          <FolderIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {/* 收起时给出里面有多少项：否则看不出是空目录还是被折起来了 */}
          {open || children.length === 0 ? null : (
            <span className="shrink-0 text-[10px]">{children.length}</span>
          )}
        </button>
        {open ? (
          <div className="ml-3 border-l pl-2">
            {children.map((child) => (
              <SessionNode
                key={child.path}
                node={child}
                collapsed={collapsed}
                onToggle={onToggle}
                onPreview={onPreview}
                onDownload={onDownload}
              />
            ))}
          </div>
        ) : null}
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

/** 拍平后的一行：目录与文件同形，靠 `depth` 缩进（虚拟化只接受一维数组） */
interface WorkspaceRow {
  path: string
  name: string
  depth: number
  type: 'dir' | 'file'
  /** 目录：直接子项数（收起时显示，区分空目录与被折起来） */
  childCount?: number
  file?: AgentWorkspaceFile
}

/** 树 → 当前可见行；折叠的目录只留自己那一行，子树整段不出现 */
export function flattenWorkspaceRows(
  nodes: readonly WorkspaceTreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): WorkspaceRow[] {
  const rows: WorkspaceRow[] = []
  for (const node of nodes) {
    if (node.type === 'dir') {
      const children = node.children ?? []
      rows.push({
        path: node.path,
        name: node.name,
        depth,
        type: 'dir',
        childCount: children.length,
      })
      if (!collapsed.has(node.path)) {
        rows.push(...flattenWorkspaceRows(children, collapsed, depth + 1))
      }
    } else if (node.file) {
      rows.push({ path: node.path, name: node.name, depth, type: 'file', file: node.file })
    }
  }
  return rows
}

function WorkspaceRowView({
  row,
  collapsed,
  onToggle,
  onPreview,
  onDownload,
}: {
  row: WorkspaceRow
  collapsed: ReadonlySet<string>
  onToggle: (path: string) => void
  onPreview: (file: AgentWorkspaceFile) => void
  onDownload: (file: AgentWorkspaceFile) => void
}) {
  // 缩进代替原来递归嵌套的 `border-l` 竖线：虚拟化后每行独立挂载，跨行画竖线会断成一段一段
  const indent = 6 + row.depth * 12
  if (row.type === 'dir') {
    const open = !collapsed.has(row.path)
    return (
      <button
        type="button"
        aria-expanded={open}
        title={open ? '收起' : '展开'}
        onClick={() => onToggle(row.path)}
        style={{ paddingLeft: indent }}
        className="flex w-full items-center gap-1.5 rounded py-1 pr-1.5 text-left text-xs text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronDownIcon
          className={cn('size-3.5 shrink-0 transition-transform', !open && '-rotate-90')}
        />
        <FolderIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{row.name}</span>
        {open || !row.childCount ? null : (
          <span className="shrink-0 text-[10px]">{row.childCount}</span>
        )}
      </button>
    )
  }
  const file = row.file
  if (!file) return null
  return (
    <FileRow
      name={row.name}
      bytes={file.bytes}
      indent={indent}
      onPreview={() => onPreview(file)}
      onDownload={() => onDownload(file)}
    />
  )
}

function FileRow({
  name,
  bytes,
  source,
  indent,
  onPreview,
  onDownload,
}: {
  name: string
  bytes: number
  source?: 'user' | 'ai'
  indent?: number
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
      style={indent === undefined ? undefined : { paddingLeft: indent }}
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

/** 会话文件树里所有目录的路径（「全部收起」用；顺序无所谓） */
function collectSessionDirPaths(nodes: readonly AgentFileNode[]): string[] {
  const result: string[] = []
  const walk = (list: readonly AgentFileNode[]) => {
    for (const node of list) {
      if (node.type !== 'dir') continue
      result.push(node.path)
      walk(node.children ?? [])
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

/** 工作区树里所有目录的路径（「全部收起」用） */
function collectDirPaths(nodes: readonly WorkspaceTreeNode[]): string[] {
  const result: string[] = []
  const walk = (list: readonly WorkspaceTreeNode[]) => {
    for (const node of list) {
      if (node.type !== 'dir') continue
      result.push(node.path)
      walk(node.children ?? [])
    }
  }
  walk(nodes)
  return result
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
