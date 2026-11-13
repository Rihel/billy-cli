'use client'

import type { CSSProperties } from 'react'

import { cn } from '#lib/utils'
import { Button } from '#components/ui/button'
import { DownloadIcon, FileIcon, LinkIcon } from 'lucide-react'
import { useStorageAdapter } from '#components/storage-provider'

export type StorageFileValue = {
  key: string
  name: string
  type?: string
  size?: number
}

export type FilePreviewProps = {
  file: StorageFileValue
  height?: CSSProperties['height']
  className?: string
}

const getExtension = (file: StorageFileValue) => file.name.split('.').at(-1)?.toLowerCase() ?? ''

/** 文件预览：图片 / 视频 / 音频 / 文档内嵌预览，其余类型提供打开与下载 */
export function FilePreview({ file, height = 560, className }: FilePreviewProps) {
  const { resolveUrl } = useStorageAdapter()
  const url = resolveUrl(file.key)
  const extension = getExtension(file)
  const isImage =
    file.type?.startsWith('image/') ||
    ['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(extension)
  const isVideo =
    file.type?.startsWith('video/') || ['m4v', 'mov', 'mp4', 'ogg', 'webm'].includes(extension)
  const isAudio =
    file.type?.startsWith('audio/') ||
    ['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav'].includes(extension)
  const isDocument =
    file.type === 'application/pdf' ||
    file.type?.startsWith('text/') ||
    ['csv', 'json', 'md', 'pdf', 'txt'].includes(extension)

  if (isImage) {
    return (
      <div
        className={cn('flex items-center justify-center overflow-auto', className)}
        style={{ height }}
      >
        <img src={url} alt={file.name} className="h-full w-full object-contain" />
      </div>
    )
  }

  if (isVideo) {
    return (
      // 任意用户文件的预览，没有字幕源可挂 <track>
      // oxlint-disable-next-line jsx-a11y/media-has-caption
      <video
        className={cn('w-full bg-black object-contain', className)}
        style={{ height }}
        src={url}
        controls
      >
        当前浏览器不支持视频预览。
      </video>
    )
  }

  if (isAudio) {
    return (
      <div
        className={cn('flex items-center justify-center bg-muted/50 px-6', className)}
        style={{ height }}
      >
        {/* 任意用户文件的预览，没有字幕源可挂 <track> */}
        {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
        <audio className="w-full" src={url} controls>
          当前浏览器不支持音频预览。
        </audio>
      </div>
    )
  }

  if (isDocument) {
    return (
      <iframe
        className={cn('w-full border-0 bg-background', className)}
        style={{ height }}
        src={url}
        title={file.name}
      />
    )
  }

  return (
    <div
      className={cn('flex flex-col items-center justify-center gap-3 text-center', className)}
      style={{ minHeight: height }}
    >
      <FileIcon className="size-10 text-muted-foreground" />
      <div className="text-sm font-medium">{file.name}</div>
      <div className="text-xs text-muted-foreground">当前文件类型不支持在线预览</div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          render={<a href={url} target="_blank" aria-label="打开文件" />}
        >
          <LinkIcon />
          打开文件
        </Button>
        <Button
          size="sm"
          render={
            <a href={url} target="_blank" download={file.name} aria-label={`下载 ${file.name}`} />
          }
        >
          <DownloadIcon />
          下载
        </Button>
      </div>
    </div>
  )
}
