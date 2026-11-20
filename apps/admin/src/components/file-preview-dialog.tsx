'use client'

import { formatFileSize } from '@repo/shared/browser'
import { Button, cn, Dialog, DialogContent, DialogHeader, DialogTitle, FilePreview } from '@repo/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { fileIconOf } from '@/components/file-type-icon'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
} from 'lucide-react'
import { useHotkeys } from 'react-hotkeys-hook'
import { toastError, toastSuccess } from '@repo/ui'
import { MessageResponse } from '@repo/ui/components/ai-elements/message.tsx'
import { SandboxFrame } from '@repo/ui/components/ai-elements/markdown-fences/sandbox-frame.tsx'
import { OfficePreview, type OfficeKind } from '@/components/office-preview'
import { MonacoCodePreview } from '@/components/monaco-code-preview'
import {
  FullscreenButton,
  FullscreenExitButton,
  usePreviewFullscreen,
} from '@/components/preview-fullscreen'
import { copyText } from '@/lib/clipboard'

/** 预览弹窗里一份文件的最小视图模型（不绑定会话 / 后台某一种列表） */
export interface PreviewDialogItem {
  id: string
  filename: string
  subtitle?: string
  badge?: string
  mediaType: string
  bytes: number
  /** 相对路径（用于左侧树形分组；没有就按 filename 平铺） */
  path?: string
  /** 可直接放进 FilePreview 的地址；文本类可以为 null */
  url: string | null
  /** 需要异步换链接的类型（如工作区文件要先物化到 OSS）；只对当前项调用 */
  loadUrl?: () => Promise<string>
  /** PPTX 渲染器需要原始字节；只有可渲染的 PPTX 才给 */
  loadBytes?: () => Promise<ArrayBuffer>
}

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'log',
  'sql',
  'ini',
  'conf',
  'toml',
  'properties',
  'sh',
  'bash',
  'py',
  'ts',
  'tsx',
  'js',
  'jsx',
  'java',
  'go',
  'rs',
  'rb',
  'php',
  'c',
  'h',
  'cpp',
  'hpp',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
  'graphql',
  'gql',
])

const extOf = (filename: string): string => {
  const base = filename.split('/').pop() ?? filename
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index + 1).toLowerCase() : ''
}

export const isPreviewTextItem = (
  item: Pick<PreviewDialogItem, 'filename' | 'mediaType'>,
): boolean =>
  item.mediaType.startsWith('text/') ||
  [
    'application/json',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
    'application/javascript',
    'application/typescript',
    'application/sql',
  ].includes(item.mediaType) ||
  TEXT_EXTENSIONS.has(extOf(item.filename))

const isHtml = (item: PreviewDialogItem): boolean =>
  item.mediaType === 'text/html' || ['html', 'htm'].includes(extOf(item.filename))

const isMarkdown = (item: PreviewDialogItem): boolean =>
  item.mediaType === 'text/markdown' || ['md', 'markdown'].includes(extOf(item.filename))

const OFFICE_TYPES: Record<string, OfficeKind> = {
  docx: 'docx',
  xlsx: 'xlsx',
  xls: 'xlsx',
  pptx: 'pptx',
}

const OFFICE_MEDIA_TYPES: Record<string, OfficeKind> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}

export const officeKind = (
  item: Pick<PreviewDialogItem, 'filename' | 'mediaType'>,
): OfficeKind | null =>
  OFFICE_MEDIA_TYPES[item.mediaType] ?? OFFICE_TYPES[extOf(item.filename)] ?? null

/**
 * 通用文件预览弹窗：左侧文件清单 + 顶部上一个 / 下一个 + 全屏内容。
 *
 * 后台文件页（当前页）与聊天右栏文件树共用这一份：
 * 列表数据由调用方给，文本内容由调用方按当前 item 取（二进制走 url 直接预览）。
 *
 * 「全屏」是弹窗自己的状态：收掉侧栏 / 顶栏 / 底栏只留内容，右上角悬浮按钮还原；
 * 状态不外抛，关窗即复位，调用方的 props 不受影响。
 */
/** 左侧树：目录 → 子目录 / 文件（按 path 分组，文件保留原下标用于切换） */
interface PreviewTreeDir {
  name: string
  path: string
  dirs: Map<string, PreviewTreeDir>
  files: { item: PreviewDialogItem; index: number }[]
}

const buildPreviewTree = (items: readonly PreviewDialogItem[]): PreviewTreeDir => {
  const root: PreviewTreeDir = { name: '', path: '', dirs: new Map(), files: [] }
  items.forEach((item, index) => {
    const rel = (item.path ?? item.filename).split('/').filter(Boolean)
    rel.pop()
    let dir = root
    for (const segment of rel) {
      const path = dir.path ? `${dir.path}/${segment}` : segment
      let next = dir.dirs.get(segment)
      if (!next) {
        next = { name: segment, path, dirs: new Map(), files: [] }
        dir.dirs.set(segment, next)
      }
      dir = next
    }
    dir.files.push({ item, index })
  })
  return root
}

type PreviewTreeRow =
  | { type: 'dir'; name: string; path: string; depth: number }
  | { type: 'file'; item: PreviewDialogItem; index: number; depth: number }

const flattenPreviewTree = (
  dir: PreviewTreeDir,
  collapsed: ReadonlySet<string>,
  depth = 0,
): PreviewTreeRow[] => {
  const rows: PreviewTreeRow[] = []
  for (const child of [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    rows.push({ type: 'dir', name: child.name, path: child.path, depth })
    if (!collapsed.has(child.path)) rows.push(...flattenPreviewTree(child, collapsed, depth + 1))
  }
  for (const file of [...dir.files].sort((a, b) =>
    a.item.filename.localeCompare(b.item.filename),
  )) {
    rows.push({ type: 'file', item: file.item, index: file.index, depth })
  }
  return rows
}

export function FilePreviewDialog({
  items,
  index,
  onIndexChange,
  onClose,
  onDownload,
  text,
  loading,
}: {
  items: readonly PreviewDialogItem[]
  index: number | null
  onIndexChange: (index: number) => void
  onClose: () => void
  onDownload: (item: PreviewDialogItem) => void
  text: string | null
  loading: boolean
}) {
  const current = index === null ? null : items[index]
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())
  /** 左侧文件树宽度（可拖动分隔条调整；不含小屏，小屏本来就把树收起） */
  const [sidebarWidth, setSidebarWidth] = useState(256)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      setSidebarWidth(Math.min(520, Math.max(180, drag.startWidth + event.clientX - drag.startX)))
    }
    const onUp = (): void => {
      dragRef.current = null
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])
  const treeRows = useMemo(
    () => flattenPreviewTree(buildPreviewTree(items), collapsedDirs),
    [items, collapsedDirs],
  )
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  /** markdown / html 可以切「预览 ↔ 代码」（其余文件只有一种形态） */
  const [codeMode, setCodeMode] = useState(false)
  const {
    fullscreen,
    toggle: toggleFullscreen,
    exit: exitFullscreen,
  } = usePreviewFullscreen(index !== null)

  useEffect(() => {
    setResolvedUrl(null)
    setUrlError(null)
    setCopied(false)
    setCodeMode(false)
    if (!current?.loadUrl) {
      return
    }
    let cancelled = false
    void current
      .loadUrl()
      .then((url) => {
        if (!cancelled) setResolvedUrl(url)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setUrlError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
    // 以 id 为触发键；loadUrl 是父组件每次渲染新建的函数，依赖它会导致重复请求
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])

  // 文件切换用上下键；左右键留给 PPT 内部翻页，避免两套导航抢同一个键
  useHotkeys(
    'up',
    () => {
      if (index !== null && index > 0) onIndexChange(index - 1)
    },
    { enabled: index !== null && index > 0, preventDefault: true },
    [index, onIndexChange],
  )
  useHotkeys(
    'down',
    () => {
      if (index !== null && index < items.length - 1) onIndexChange(index + 1)
    },
    { enabled: index !== null && index < items.length - 1, preventDefault: true },
    [index, items.length, onIndexChange],
  )

  if (!current || index === null) return null
  const html = isHtml(current)
  const markdown = isMarkdown(current)
  const isText = isPreviewTextItem(current)
  const hasPrev = index > 0
  const hasNext = index < items.length - 1
  const canCopy = (isText || html || markdown) && !loading && text !== null
  /** 有专门渲染的文件（markdown / html）可以切代码视图 */
  const canToggleView = html || markdown
  /** 二进制（非文本、非 Office、非图片/PDF）不尝试预览 */
  const binaryUnsupported =
    !isText &&
    !html &&
    !markdown &&
    !officeKind(current) &&
    !current.mediaType.startsWith('image/') &&
    current.mediaType !== 'application/pdf'

  const copyCurrent = async () => {
    try {
      await copyText(text ?? '')
      setCopied(true)
      toastSuccess('已复制到剪贴板')
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return
        // 全屏态按 Esc 只收 chrome：先退全屏，再按一次才关窗
        if (fullscreen && details.reason === 'escape-key') {
          details.cancel()
          exitFullscreen()
          return
        }
        exitFullscreen()
        onClose()
      }}
    >
      <DialogContent
        bodyScroll={false}
        className={cn(
          'flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 rounded-none p-0 sm:max-w-none',
          // 全屏时内置关闭键浮在任意内容上（黑色视频 / 白底文档都得看得见）：给同一层半透明底
          fullscreen &&
            '[&>[data-slot=dialog-close]]:rounded-full [&>[data-slot=dialog-close]]:bg-background/90 [&>[data-slot=dialog-close]]:shadow-sm [&>[data-slot=dialog-close]]:backdrop-blur',
        )}
      >
        {fullscreen ? (
          // 顶栏收掉后标题只剩读屏可见：Dialog 的 aria-labelledby 要有一个节点可指
          <DialogTitle className="sr-only">{current.filename}</DialogTitle>
        ) : (
          <DialogHeader className="shrink-0 border-b px-4 py-3 pr-14">
            <div className="flex min-w-0 items-center gap-2">
              <DialogTitle className="truncate text-sm">{current.filename}</DialogTitle>
              <span className="shrink-0 text-xs text-muted-foreground">
                {index + 1} / {items.length}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1 pr-2">
                {canToggleView ? (
                  <div className="mr-1 flex items-center rounded-md border border-border p-0.5">
                    <Button
                      size="sm"
                      variant={codeMode ? 'ghost' : 'secondary'}
                      className="h-6 px-2 text-[11px]"
                      onClick={() => setCodeMode(false)}
                    >
                      预览
                    </Button>
                    <Button
                      size="sm"
                      variant={codeMode ? 'secondary' : 'ghost'}
                      className="h-6 px-2 text-[11px]"
                      onClick={() => setCodeMode(true)}
                    >
                      代码
                    </Button>
                  </div>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!hasPrev}
                  onClick={() => onIndexChange(index - 1)}
                  title="上一个文件（↑）"
                  aria-label="上一个文件"
                >
                  <ChevronUpIcon className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={!hasNext}
                  onClick={() => onIndexChange(index + 1)}
                  title="下一个文件（↓）"
                  aria-label="下一个文件"
                >
                  <ChevronDownIcon className="size-4" />
                </Button>
                <FullscreenButton onClick={toggleFullscreen} />
              </div>
            </div>
          </DialogHeader>
        )}

        <div className="relative flex min-h-0 flex-1">
          {/* 左侧文件清单：大屏常驻，小屏收起（顶部上一个 / 下一个仍可用）；全屏时收掉 */}
          {fullscreen ? null : (
            <aside
              aria-label="文件列表"
              style={{ width: sidebarWidth }}
              className="hidden shrink-0 overflow-y-auto border-r bg-surface-1 p-2 sm:block"
            >
              <div className="px-2 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                文件列表（{items.length}）
              </div>
              {treeRows.map((row) =>
                row.type === 'dir' ? (
                  <button
                    key={`dir:${row.path}`}
                    type="button"
                    onClick={() =>
                      setCollapsedDirs((previous) => {
                        const next = new Set(previous)
                        if (next.has(row.path)) next.delete(row.path)
                        else next.add(row.path)
                        return next
                      })
                    }
                    style={{ paddingLeft: 8 + row.depth * 12 }}
                    className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-xs text-muted-foreground hover:bg-muted/60"
                  >
                    <ChevronRightIcon
                      className={
                        collapsedDirs.has(row.path)
                          ? 'size-3 shrink-0'
                          : 'size-3 shrink-0 rotate-90'
                      }
                    />
                    <FolderIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  </button>
                ) : (
                  <button
                    key={row.item.id}
                    type="button"
                    onClick={() => onIndexChange(row.index)}
                    style={{ paddingLeft: 8 + row.depth * 12 + 16 }}
                    className={
                      row.index === index
                        ? 'flex w-full flex-col gap-0.5 rounded-md bg-muted py-1.5 pr-2 text-left'
                        : 'flex w-full flex-col gap-0.5 rounded-md py-1.5 pr-2 text-left hover:bg-muted/60'
                    }
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {(() => {
                        const Icon = fileIconOf(row.item.filename)
                        return <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      })()}
                      <span
                        className={
                          row.item.badge === '工作区'
                            ? 'truncate text-[11px] font-normal'
                            : 'truncate text-xs font-medium'
                        }
                      >
                        {row.item.filename}
                      </span>
                    </span>
                    {/* 工作区文件：列表里只给文件名，大小 / 来源等留给预览区，别把树撑成两行 */}
                    {row.item.badge === '工作区' ? null : (
                      <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        {row.item.badge ? <span>{row.item.badge}</span> : null}
                        {row.item.subtitle ? (
                          <span className="truncate">{row.item.subtitle}</span>
                        ) : null}
                        <span className="ml-auto shrink-0">{formatFileSize(row.item.bytes)}</span>
                      </span>
                    )}
                  </button>
                ),
              )}
            </aside>
          )}

          {/* 可拖动分隔条：拖拽改左栏宽度（键盘左右键也能调，焦点在分隔条上时） */}
          {fullscreen ? null : (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整文件列表宽度"
              tabIndex={0}
              onPointerDown={(event) => {
                dragRef.current = { startX: event.clientX, startWidth: sidebarWidth }
                document.body.style.userSelect = 'none'
                document.body.style.cursor = 'col-resize'
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                setSidebarWidth((width) =>
                  Math.min(520, Math.max(180, width + (event.key === 'ArrowRight' ? 16 : -16))),
                )
              }}
              className="hidden w-1 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-border sm:block"
            />
          )}

          <div
            className={html ? 'min-h-0 flex-1 overflow-hidden' : 'min-h-0 flex-1 overflow-auto p-4'}
          >
            {officeKind(current) && current.loadBytes ? (
              <OfficePreview
                key={current.id}
                kind={officeKind(current)!}
                loadBytes={current.loadBytes}
                filename={current.filename}
              />
            ) : html ? (
              loading ? (
                <Empty text="正在读取…" />
              ) : (
                <SandboxFrame
                  html={text ?? ''}
                  title={current.filename}
                  language="html"
                  frameless
                  className="h-full"
                />
              )
            ) : canToggleView && codeMode ? (
              <MonacoCodePreview filename={current.filename} value={text ?? ''} />
            ) : binaryUnsupported ? (
              <Empty text="这是二进制文件，不支持在线预览，请下载查看。" />
            ) : isText ? (
              loading ? (
                <Empty text="正在读取…" />
              ) : markdown ? (
                <div className="px-6 py-2 sm:px-10">
                  <MessageResponse className="text-sm">{text ?? ''}</MessageResponse>
                </div>
              ) : (
                // 除 markdown（富文本）/ html（沙箱）/ Office 这些专门渲染的以外，
                // 文本文件一律交给 Monaco（未知扩展名按 plaintext，可选中/查找/折叠）
                <MonacoCodePreview filename={current.filename} value={text ?? ''} />
              )
            ) : current.url || resolvedUrl ? (
              <FilePreview
                file={{
                  key: (current.url ?? resolvedUrl)!,
                  name: current.filename,
                  type: current.mediaType,
                  size: current.bytes,
                }}
                height="100%"
              />
            ) : current.loadUrl && !urlError ? (
              <Empty text="正在获取文件链接…" />
            ) : urlError ? (
              <Empty text={`获取预览链接失败：${urlError}`} />
            ) : (
              <Empty text="当前类型不支持在线预览，请下载查看。" />
            )}
          </div>

          {/* 全屏态唯一的外露控件：让开内置关闭键（right-2 + 28px），和它并排 */}
          {fullscreen ? (
            <FullscreenExitButton
              onClick={exitFullscreen}
              className="absolute top-2 right-10 z-30"
            />
          ) : null}
        </div>

        {fullscreen ? null : (
          <div className="flex shrink-0 justify-end gap-2 border-t px-4 py-3">
            {canCopy ? (
              <Button variant="outline" size="sm" onClick={() => void copyCurrent()}>
                {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                {copied ? '已复制' : '复制'}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => onDownload(current)}>
              <DownloadIcon className="size-3.5" />
              下载
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full min-h-32 items-center justify-center px-6 text-center text-xs text-muted-foreground">
      {text}
    </div>
  )
}
