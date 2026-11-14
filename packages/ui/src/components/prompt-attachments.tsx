'use client'

import { useEffect, useState } from 'react'
import { FileTextIcon, XIcon } from 'lucide-react'

import { usePromptInputAttachments } from '#components/ai-elements/prompt-input.tsx'
import { useOptionalStorageAdapter } from '#components/storage-provider.tsx'
import { cn } from '#lib/utils.ts'

/** 一条附件的展示画像（表现层只认这几个字段，不认识业务模型） */
export interface PromptAttachmentItem {
  /** 稳定 key（移除时回传它） */
  key: string
  filename: string
  mediaType: string
  /** 字节数（有就显示大小） */
  bytes?: number
  /** "内容会读给模型" / "按文件传给模型" —— 两类行为不同，界面上别让用户猜 */
  behavior?: string
  /** 可选的预览地址（已发送附件由页面预先签好；本地未上传的用 blob） */
  previewUrl?: string
  /**
   * 对象存储 key（已发送附件）：没有 `previewUrl` 时，缩略图按它向服务端要**短时预签名**地址
   * （桶私有后公开直链已不可用）。
   */
  storageKey?: string
}

/** 人类可读的文件大小（1024 进制，保留一位小数） */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** 按文件名 / 媒体类型判断能不能出缩略图 */
export const isImageMedia = (filename: string, mediaType: string): boolean => {
  if (mediaType.toLowerCase().startsWith('image/')) return true
  const extension = filename.includes('.') ? (filename.split('.').pop() ?? '').toLowerCase() : ''
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'].includes(extension)
}

export type PromptAttachmentChipProps = {
  item: PromptAttachmentItem
  /** 给了移除回调才画那个叉（已发送的附件不给） */
  onRemove?: (key: string) => void
  /** 整块可点（已发送的附件用它触发"下载 / 查看原图"） */
  onClick?: (key: string) => void
  className?: string
}

/**
 * 一条附件的小卡（待发与已发送共用同一个外观）。
 *
 * 为什么表现层要收这一份 props 而不是直接吃业务模型：待发附件的真身在浏览器里（有本地预览），
 * 已发送的附件只剩存储 key（内容在对象存储），两者能拿到的信息不同 ——
 * 组件只认"能拿到的这些字段"，由调用方决定填哪些，避免到处是可选分支。
 */
export const PromptAttachmentChip = ({
  item,
  onRemove,
  onClick,
  className,
}: PromptAttachmentChipProps) => {
  // 没有 StorageProvider 也能渲染（单测 / 嵌入场景）；有才按 storageKey 现签预览地址
  const adapter = useOptionalStorageAdapter()
  const image = isImageMedia(item.filename, item.mediaType)
  const clickable = Boolean(onClick)
  const Wrapper = clickable ? 'button' : 'div'
  /**
   * 预览地址加载失败时退回文件图标。
   *
   * 为什么按 URL 记而不是一个布尔：同一条附件在"历史重建 → 重新签地址"后 URL 会变，
   * 用布尔会把新地址也永久判死。地址变了就重新试一次。
   */
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  /** `storageKey` 换来的短时预签名地址（桶私有后已发送附件没有公开直链） */
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null)

  useEffect(() => {
    if (item.previewUrl || !item.storageKey || !adapter?.getViewUrl) return
    let cancelled = false
    void adapter
      .getViewUrl(item.storageKey)
      .then((url) => {
        if (!cancelled) setResolvedUrl(url)
      })
      .catch(() => {
        // 签不到地址就退回文件图标（文件名 / 大小仍然可见）
      })
    return () => {
      cancelled = true
    }
    // 只按标识触发：回调函数每次渲染都是新的，放进来会无限重签
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [item.key, item.storageKey])

  const previewSrc = item.previewUrl ?? resolvedUrl
  const showImage = image && Boolean(previewSrc) && failedUrl !== previewSrc

  return (
    <Wrapper
      {...(clickable ? { onClick: () => onClick?.(item.key), type: 'button' as const } : {})}
      className={cn(
        'relative flex items-center gap-2 rounded-md bg-surface-2 p-1.5',
        clickable && 'text-left hover:bg-surface-3',
        onRemove && 'pr-7',
        className,
      )}
      title={item.filename}
    >
      {showImage ? (
        // 用原生 `<img>`：预览地址可能是 blob（本地未上传）或对象存储直链，
        // 都不该进 Next 的图片优化管线（前者根本走不通）
        <img
          alt={item.filename}
          className="size-10 rounded object-cover"
          src={previewSrc ?? undefined}
          // 地址失效（桶配错 / 预签名过期 / 对象被删）时退回文件卡，
          // 而不是给用户一个破图 —— 文件名与大小仍然看得见
          onError={() => setFailedUrl(previewSrc ?? null)}
        />
      ) : (
        <span className="flex size-10 items-center justify-center rounded bg-background">
          <FileTextIcon className="size-4 text-muted-foreground" />
        </span>
      )}
      <span className="flex max-w-[14rem] min-w-0 flex-col">
        <span className="truncate text-xs">{item.filename}</span>
        <span className="text-[10px] text-muted-foreground">
          {[item.behavior, item.bytes === undefined ? undefined : formatBytes(item.bytes)]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      {onRemove ? (
        <button
          aria-label={`移除 ${item.filename}`}
          className="absolute top-1 right-1 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
          onClick={(event) => {
            // 整卡可能是 button（可点开原图）时，别让移除也触发打开
            event.stopPropagation()
            onRemove(item.key)
          }}
          title="移除"
          type="button"
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </Wrapper>
  )
}

export type PromptAttachmentsProps = {
  items: readonly PromptAttachmentItem[]
  onRemove?: (key: string) => void
  onClick?: (key: string) => void
  /**
   * 点图片时给调用方"要看的这张"（其余的可预览图片与它在列表里的下标）。
   *
   * 为什么把**列表**也一起给：查看器要能左右翻页，而"可翻的集合"是调用方才知道的
   * （输入框待发附件与消息里已发送的附件是两份不同的列表，地址来源也不同）。
   * 由调用方在点击那一刻给出完整集合，比在这里缓存一份更不容易失配。
   */
  onPreviewImage?: (items: readonly PromptAttachmentItem[], index: number) => void
  className?: string
}

/** 一组附件（输入框上方一行 / 已发送消息里一行） */
export const PromptAttachments = ({
  items,
  onRemove,
  onClick,
  onPreviewImage,
  className,
}: PromptAttachmentsProps) => {
  if (items.length === 0) return null

  /**
   * 可预览的图片（有地址、且是图片格式）——查看器只在它们之间翻页：
   * 夹一个 pdf 进来，翻页时跳到它没意义。
   */
  const previewable = onPreviewImage
    ? items.filter(
        (item) =>
          Boolean(item.previewUrl || item.storageKey) &&
          isImageMedia(item.filename, item.mediaType),
      )
    : []

  return (
    <div className={cn('flex w-full flex-wrap items-center justify-start gap-2', className)}>
      {items.map((item) => {
        const previewIndex = previewable.findIndex((candidate) => candidate.key === item.key)
        /**
         * 点击行为分两种（图片优先）：
         * - 图片且有地址 → 打开查看器（他点缩略图就是想放大看）；
         * - 其余（或调用方没给预览能力）→ 交给 `onClick`（例如下载）。
         */
        const handleClick =
          onPreviewImage && previewIndex >= 0
            ? () => onPreviewImage(previewable, previewIndex)
            : onClick
        return (
          <PromptAttachmentChip
            key={item.key}
            item={item}
            {...(onRemove ? { onRemove } : {})}
            {...(handleClick ? { onClick: handleClick } : {})}
          />
        )
      })}
    </div>
  )
}

/** 输入框上方的**待发附件条**：数据直接来自 `PromptInput` 自己的附件状态 */
export const PromptInputAttachmentsBar = ({
  className,
  onPreviewImage,
}: {
  className?: string
  /** 点缩略图放大看（由页面提供查看器；不传就是不可点） */
  onPreviewImage?: (items: readonly PromptAttachmentItem[], index: number) => void
}) => {
  // 这个 hook 只能在 `<PromptInput>` 内部用（附件状态由它提供）
  const attachments = usePromptInputAttachments()
  if (attachments.files.length === 0) return null

  return (
    <PromptAttachments
      className={cn('px-1', className)}
      items={attachments.files.map((file) => ({
        key: file.id,
        filename: file.filename ?? '未命名文件',
        mediaType: file.mediaType ?? '',
        ...(file.url ? { previewUrl: file.url } : {}),
      }))}
      onRemove={(id) => attachments.remove(id)}
      {...(onPreviewImage ? { onPreviewImage } : {})}
    />
  )
}
