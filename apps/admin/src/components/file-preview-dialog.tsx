'use client'

import { useEffect } from 'react'
import { formatFileSize } from '@repo/shared/browser'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  FilePreview,
  Markdown,
} from '@repo/ui'
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon } from 'lucide-react'
import { SandboxFrame } from '@repo/ui/components/ai-elements/markdown-fences/sandbox-frame.tsx'

/** 预览弹窗里一份文件的最小视图模型（不绑定会话 / 后台某一种列表） */
export interface PreviewDialogItem {
  id: string
  filename: string
  subtitle?: string
  badge?: string
  mediaType: string
  bytes: number
  /** 可直接放进 FilePreview 的地址；文本类可以为 null */
  url: string | null
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml',
  'html', 'htm', 'log', 'sql', 'ini', 'conf', 'toml', 'properties', 'sh', 'bash',
  'py', 'ts', 'tsx', 'js', 'jsx', 'java', 'go', 'rs', 'rb', 'php', 'c', 'h',
  'cpp', 'hpp', 'css', 'scss', 'less', 'vue', 'svelte', 'graphql', 'gql',
])

const extOf = (filename: string): string => {
  const base = filename.split('/').pop() ?? filename
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index + 1).toLowerCase() : ''
}

export const isPreviewTextItem = (item: Pick<PreviewDialogItem, 'filename' | 'mediaType'>): boolean =>
  item.mediaType.startsWith('text/') ||
  ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml',
    'application/javascript', 'application/typescript', 'application/sql'].includes(item.mediaType) ||
  TEXT_EXTENSIONS.has(extOf(item.filename))

const isHtml = (item: PreviewDialogItem): boolean =>
  item.mediaType === 'text/html' || ['html', 'htm'].includes(extOf(item.filename))

const isMarkdown = (item: PreviewDialogItem): boolean =>
  item.mediaType === 'text/markdown' || ['md', 'markdown'].includes(extOf(item.filename))

/**
 * 通用文件预览弹窗：左侧文件清单 + 顶部上一个 / 下一个 + 全屏内容。
 *
 * 后台文件页（当前页）与聊天右栏文件树共用这一份：
 * 列表数据由调用方给，文本内容由调用方按当前 item 取（二进制走 url 直接预览）。
 */
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

  useEffect(() => {
    if (index === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault()
        onIndexChange(index - 1)
      } else if (event.key === 'ArrowRight' && index < items.length - 1) {
        event.preventDefault()
        onIndexChange(index + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [index, items.length, onIndexChange])

  if (!current || index === null) return null
  const html = isHtml(current)
  const markdown = isMarkdown(current)
  const isText = isPreviewTextItem(current)
  const hasPrev = index > 0
  const hasNext = index < items.length - 1

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        bodyScroll={false}
        className="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 rounded-none p-0 sm:max-w-none"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-14">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="truncate text-sm">{current.filename}</DialogTitle>
            <span className="shrink-0 text-xs text-muted-foreground">
              {index + 1} / {items.length}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1 pr-2">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!hasPrev}
                onClick={() => onIndexChange(index - 1)}
                title="上一个文件（←）"
                aria-label="上一个文件"
              >
                <ChevronLeftIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!hasNext}
                onClick={() => onIndexChange(index + 1)}
                title="下一个文件（→）"
                aria-label="下一个文件"
              >
                <ChevronRightIcon className="size-4" />
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* 左侧文件清单：大屏常驻，小屏收起（顶部上一个 / 下一个仍可用） */}
          <aside
            aria-label="文件列表"
            className="hidden w-64 shrink-0 overflow-y-auto border-r bg-surface-1 p-2 sm:block"
          >
            <div className="px-2 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              文件列表（{items.length}）
            </div>
            {items.map((item, itemIndex) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onIndexChange(itemIndex)}
                className={
                  itemIndex === index
                    ? 'flex w-full flex-col gap-0.5 rounded-md bg-muted px-2 py-1.5 text-left'
                    : 'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/60'
                }
              >
                <span className="truncate text-xs font-medium">{item.filename}</span>
                <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  {item.badge ? <span>{item.badge}</span> : null}
                  {item.subtitle ? <span className="truncate">{item.subtitle}</span> : null}
                  <span className="ml-auto shrink-0">{formatFileSize(item.bytes)}</span>
                </span>
              </button>
            ))}
          </aside>

          <div
            className={
              html
                ? 'min-h-0 flex-1 overflow-hidden'
                : 'min-h-0 flex-1 overflow-auto p-4'
            }
          >
            {html ? (
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
            ) : isText ? (
              loading ? (
                <Empty text="正在读取…" />
              ) : markdown ? (
                <Markdown content={text ?? ''} />
              ) : (
                <pre className="whitespace-pre-wrap break-words text-xs">{text ?? ''}</pre>
              )
            ) : current.url ? (
              <FilePreview
                file={{
                  key: current.url,
                  name: current.filename,
                  type: current.mediaType,
                  size: current.bytes,
                }}
                height="100%"
              />
            ) : (
              <Empty text="当前类型不支持在线预览，请下载查看。" />
            )}
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" size="sm" onClick={() => onDownload(current)}>
            <DownloadIcon className="size-3.5" />
            下载
          </Button>
        </div>
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
