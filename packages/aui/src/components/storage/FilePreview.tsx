'use client'

import { DownloadOutlined, FileOutlined, LinkOutlined } from '@ant-design/icons'
import { Button, Image, Result, Space } from 'antd'
import type { CSSProperties } from 'react'
import { cn } from '../../lib/css'
import { useStorageAdapter } from './StorageProvider'

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

const getExtension = (file: StorageFileValue) =>
  file.name.split('.').at(-1)?.toLowerCase() ?? ''

export const FilePreview = ({
  file,
  height = 560,
  className,
}: FilePreviewProps) => {
  const { resolveUrl } = useStorageAdapter()
  const url = resolveUrl(file.key)
  const extension = getExtension(file)
  const isImage =
    file.type?.startsWith('image/') ||
    ['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(
      extension,
    )
  const isVideo =
    file.type?.startsWith('video/') ||
    ['m4v', 'mov', 'mp4', 'ogg', 'webm'].includes(extension)
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
        className={cn(
          'flex items-center justify-center overflow-auto',
          className,
        )}
        style={{ height }}
      >
        <Image
          src={url}
          alt={file.name}
          preview={false}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    )
  }

  if (isVideo) {
    return (
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
        className={cn(
          'flex items-center justify-center bg-gray-50 px-6',
          className,
        )}
        style={{ height }}
      >
        <audio className="w-full max-w-xl" src={url} controls>
          当前浏览器不支持音频预览。
        </audio>
      </div>
    )
  }

  if (isDocument) {
    return (
      <iframe
        className={cn('w-full border-0 bg-white', className)}
        style={{ height }}
        src={url}
        title={file.name}
      />
    )
  }

  return (
    <div className={className} style={{ minHeight: height }}>
      <Result
        icon={<FileOutlined />}
        title={file.name}
        subTitle="当前文件类型不支持在线预览"
        extra={
          <Space>
            <Button icon={<LinkOutlined />} href={url} target="_blank">
              打开文件
            </Button>
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              href={url}
              target="_blank"
              download={file.name}
            >
              下载
            </Button>
          </Space>
        }
      />
    </div>
  )
}
