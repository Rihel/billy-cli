'use client'

import { formatFileSize } from '@repo/shared/browser'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, FilePreview } from '@repo/ui'
import { useEffect, useState } from 'react'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, DownloadIcon } from 'lucide-react'
import { useHotkeys } from 'react-hotkeys-hook'
import { toastError, toastSuccess } from '@repo/ui'
import { MessageResponse } from '@repo/ui/components/ai-elements/message.tsx'
import { SandboxFrame } from '@repo/ui/components/ai-elements/markdown-fences/sandbox-frame.tsx'
import { OfficePreview, type OfficeKind } from '@/components/office-preview'
import { copyText } from '@/lib/clipboard'

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
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setResolvedUrl(null)
    setUrlError(null)
    setCopied(false)
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
            ) : isText ? (
              loading ? (
                <Empty text="正在读取…" />
              ) : markdown ? (
                <div className="px-6 py-2 sm:px-10">
                  <MessageResponse className="text-sm">{text ?? ''}</MessageResponse>
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words text-xs">{text ?? ''}</pre>
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
        </div>

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
