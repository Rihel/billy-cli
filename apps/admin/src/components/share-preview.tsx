'use client'

import { useEffect, useState } from 'react'
import { DownloadIcon, FileIcon } from 'lucide-react'
import { Button } from '@repo/ui'
import { Markdown } from '@repo/ui/components/markdown.tsx'
import { SandboxFrame } from '@repo/ui/components/ai-elements/markdown-fences/sandbox-frame.tsx'
import type { ShareMetaModel } from '@repo/shared'
import { OfficePreview } from '@/components/office-preview'

/**
 * 分享页的预览体（设计 `docs/design/file-share.md` §6.2）。
 *
 * 渲染方式由服务端下发的 `previewKind` 决定，前端**不猜扩展名**：
 * - 图片 / 音视频 / PDF：直接吃 `/api/s/{token}/content`（浏览器原生，可 Range）；
 * - 文本 / Markdown / HTML：取文本后渲染（HTML 走沙箱，不当页面执行）；
 * - Office：取 ArrayBuffer 交给 `OfficePreview`；
 * - `none`：只给文件信息 + 下载。
 *
 * 这里是**唯一**知道文件地址的地方 —— 地址是同源 `/api/s/{token}/content`，
 * 里面不会有 OSS 域名与签名参数。
 */

/** 文本类一次性读取的上限（与主站预览同一口径） */
const TEXT_LIMIT = 1024 * 1024

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function SharePreview({ token, meta }: { token: string; meta: ShareMetaModel }) {
  const contentUrl = `/api/s/${token}/content`
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const needsText =
    meta.previewKind === 'text' || meta.previewKind === 'markdown' || meta.previewKind === 'html'

  useEffect(() => {
    if (!needsText) return
    let cancelled = false
    setFailed(false)
    fetch(contentUrl)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status))
        return response.text()
      })
      .then((value) => {
        if (!cancelled) setText(value.slice(0, TEXT_LIMIT))
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [contentUrl, needsText])

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{meta.filename}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(meta.bytes)}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={
            <a href={contentUrl} download={meta.filename} aria-label={`下载 ${meta.filename}`} />
          }
        >
          <DownloadIcon className="size-3.5" />
          下载
        </Button>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <Body meta={meta} contentUrl={contentUrl} text={text} failed={failed} />
      </main>
    </div>
  )
}

function Body({
  meta,
  contentUrl,
  text,
  failed,
}: {
  meta: ShareMetaModel
  contentUrl: string
  text: string | null
  failed: boolean
}) {
  if (meta.previewKind === 'image') {
    return (
      <div className="flex h-full items-center justify-center p-4">
        {/* 分享页只看一个文件，用原生 img 即可（next/image 会多一层 /_next/image） */}
        <img
          src={contentUrl}
          alt={meta.filename}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    )
  }

  if (meta.previewKind === 'video') {
    return (
      <div className="flex h-full items-center justify-center bg-black">
        {/* 分享的是用户任意媒体文件，没有字幕源可挂 <track> */}
        {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={contentUrl} controls className="max-h-full w-full" />
      </div>
    )
  }

  if (meta.previewKind === 'audio') {
    return (
      <div className="flex h-full items-center justify-center px-6">
        {/* 分享的是用户任意媒体文件，没有字幕源可挂 <track> */}
        {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
        <audio src={contentUrl} controls className="w-full max-w-xl" />
      </div>
    )
  }

  if (meta.previewKind === 'pdf') {
    return <iframe src={contentUrl} title={meta.filename} className="h-full w-full border-0" />
  }

  if (meta.previewKind === 'office' && meta.officeKind) {
    return (
      <OfficePreview
        kind={meta.officeKind}
        filename={meta.filename}
        loadBytes={() =>
          fetch(contentUrl).then((response) => {
            if (!response.ok) throw new Error(`加载失败（${response.status}）`)
            return response.arrayBuffer()
          })
        }
      />
    )
  }

  if (failed) {
    return <Fallback text="文件加载失败，可能已被删除或链接已失效。" />
  }

  if (text === null) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        加载中…
      </div>
    )
  }

  if (meta.previewKind === 'html') {
    return (
      <SandboxFrame
        html={text}
        title={meta.filename}
        language="html"
        frameless
        className="h-full"
      />
    )
  }

  if (meta.previewKind === 'markdown') {
    return (
      <div className="mx-auto max-w-3xl px-6 py-6">
        <Markdown content={text} />
      </div>
    )
  }

  if (meta.previewKind === 'text') {
    return (
      <pre className="whitespace-pre-wrap break-words px-6 py-6 font-mono text-xs leading-relaxed">
        {text}
      </pre>
    )
  }

  return <Fallback text="该文件类型不支持在线预览，请下载后查看。" />
}

function Fallback({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <FileIcon className="size-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  )
}
