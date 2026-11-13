'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, XIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react'

import { FilePreview } from '#components/file-preview.tsx'
import { Dialog, DialogContent, DialogTitle } from '#components/ui/dialog.tsx'
import { toastError } from '#components/toast.ts'
import { cn } from '#lib/utils.ts'

/**
 * 附件大图查看（lightbox）：**图片可缩放拖动，其它文件按类型预览**。
 *
 * 与 `FilePreview` 的分工：那个是**内嵌预览**（塞在页面里占一块地方），
 * 这里是**弹层查看**（点缩略图打开、左右翻页、Esc 关掉）。两者不重复：
 * 非图片文件（PDF / 文本 / 视频…）的"怎么渲染"直接复用 `FilePreview`，
 * 本组件只负责弹层、翻页、标题栏与图片的缩放拖动。
 */

export interface ImageLightboxItem {
  /** 稳定标识（列表 key 与去重用） */
  id: string
  /** 可直接放进 `src` 的地址（blob 或对象存储 URL） */
  src: string
  /** 无障碍与标题栏用 */
  alt?: string
  /**
   * 媒体类型 / 文件名 / 字节数：用来决定**怎么预览**。
   *
   * 图片走可缩放的看图器；其余（PDF / 文本 / 视频 / 音频…）交给 `FilePreview`
   * —— 那个组件已经覆盖了这几类的在线预览与"不支持时打开 / 下载"的兜底。
   */
  mediaType?: string
  filename?: string
  bytes?: number
  /** 标题栏里显示的补充信息（文件名 / 大小等） */
  caption?: string
  /**
   * 点「查看原图」时由应用侧给出**可用的地址**（如服务端签一个有时效的下载链接）。
   *
   * 为什么要这一条：对象存储的桶可能是私有的 —— 回看历史时我们只存了 key，
   * 前端拼出来的地址会 403。这时"看原图"必须走应用侧签地址那条路（`@repo/ui` 不碰传输）。
   * 不传就没有这个入口，只按 `src` 显示。
   */
  onResolveOriginal?: () => Promise<string | null>
}

/** 受控的图片查看器：**自己不管状态**，由调用方决定开不开、看第几张 */
export interface ImageLightboxProps {
  items: readonly ImageLightboxItem[]
  /** 当前下标（-1 / undefined = 关闭） */
  index: number | null
  onIndexChange: (next: number) => void
  onClose: () => void
}

const MIN_SCALE = 0.5
const MAX_SCALE = 8
/** 每次点按钮的缩放步进（1.25 这种小步走，用户能停在想要的大小） */
const STEP = 1.25

/**
 * 这张是不是图片（决定用**缩放看图器**还是**文件预览器**）。
 *
 * 判据与附件上传那边一致：先看媒体类型，再按后缀兜底
 * （浏览器常把图片报成 `application/octet-stream`，只信媒体类型会误判成文件）。
 */
export const isImageItem = (
  item: Pick<ImageLightboxItem, 'mediaType' | 'filename' | 'src'>,
): boolean => {
  const mediaType = item.mediaType?.toLowerCase() ?? ''
  if (mediaType.startsWith('image/')) return true
  const name = item.filename ?? item.src
  const extension = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg'].includes(extension)
}

/**
 * 把缩放比例夹进允许区间。
 *
 * 单独抽出来是因为它同时被滚轮、按钮、双击三条路用到 —— 三处各写一遍 `Math.min/max`
 * 迟早会出现"按钮能放到 8 倍、滚轮能放到 12 倍"这种不一致。
 */
export const clampScale = (value: number): number => {
  // `NaN` 会让 `Math.min/max` 一路传成 `NaN`，进到 `transform: scale(NaN)` 就是白屏 —— 回落 1
  if (Number.isNaN(value)) return 1
  // 无穷大要按方向夹（`+Infinity` = 拼命放大 → 上限；`-Infinity` → 下限）
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

export { MAX_SCALE as IMAGE_LIGHTBOX_MAX_SCALE, MIN_SCALE as IMAGE_LIGHTBOX_MIN_SCALE }

/**
 * 可缩放的图片：滚轮缩放（以光标为中心）、拖动平移、双击复位，外加一对按钮。
 *
 * 为什么不用现成的缩放库：这里要的只是"看图"这一件事（比例 + 位移两个状态），
 * 一个 `transform` 就够了；引一个库进来反而要跟着它的手势语义走。
 *
 * 以光标为中心缩放的做法：先按中心点缩放定位，再把光标位置"补偿"回去 ——
 * 否则缩小时图片会往左上角跑，用户得先拖回来才能继续看。
 */
const ZoomableImage = ({ src, alt }: { src: string; alt: string }) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  /** 换图时复位（否则从上一张带过来的比例与位移会显得莫名其妙） */
  const [loadedSrc, setLoadedSrc] = useState(src)
  if (loadedSrc !== src) {
    setLoadedSrc(src)
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }
  const dragStart = useRef({ pointerX: 0, pointerY: 0, offsetX: 0, offsetY: 0 })

  const reset = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  const zoomAt = useCallback((next: number, clientX?: number, clientY?: number) => {
    const clamped = clampScale(next)
    const rect = containerRef.current?.getBoundingClientRect()
    setScale((prev) => {
      if (!rect || clientX === undefined || clientY === undefined) return clamped
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const ratio = clamped / prev
      setOffset((current) => ({
        x: clientX - centerX - (clientX - centerX - current.x) * ratio,
        y: clientY - centerY - (clientY - centerY - current.y) * ratio,
      }))
      return clamped
    })
  }, [])

  /**
   * 滚轮缩放要 `{ passive: false }`：浏览器的滚轮监听默认是 passive 的，
   * 在里面调 `preventDefault()` 不生效，页面会跟着一起滚（踩过这个坑的表现是"缩放时页面乱跳"）。
   */
  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = event.deltaY > 0 ? 1 / STEP : STEP
      setScale((prev) => {
        const clamped = clampScale(prev * factor)
        const rect = node.getBoundingClientRect()
        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height / 2
        const ratio = clamped / prev
        setOffset((current) => ({
          x: event.clientX - centerX - (event.clientX - centerX - current.x) * ratio,
          y: event.clientY - centerY - (event.clientY - centerY - current.y) * ratio,
        }))
        return clamped
      })
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div
        ref={containerRef}
        className={cn(
          'relative flex min-h-[50vh] flex-1 items-center justify-center overflow-hidden rounded bg-muted/30',
          scale > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in',
        )}
        onDoubleClick={() => (scale > 1 ? reset() : zoomAt(2))}
        onPointerDown={(event) => {
          if (scale <= 1) return
          event.currentTarget.setPointerCapture(event.pointerId)
          dragStart.current = {
            pointerX: event.clientX,
            pointerY: event.clientY,
            offsetX: offset.x,
            offsetY: offset.y,
          }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          if (!dragging) return
          setOffset({
            x: dragStart.current.offsetX + (event.clientX - dragStart.current.pointerX),
            y: dragStart.current.offsetY + (event.clientY - dragStart.current.pointerY),
          })
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          setDragging(false)
        }}
      >
        {/* 原生 `<img>`：地址可能是 blob 或对象存储直链，都不走 Next 的图片优化 */}
        <img
          alt={alt}
          className="max-h-[calc(100dvh-12rem)] max-w-full select-none object-contain"
          draggable={false}
          src={src}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            // 拖动时不要过渡（跟手），松手 / 缩放时给一点点，避免跳变
            transition: dragging ? 'none' : 'transform 120ms ease-out',
          }}
        />
      </div>

      {/* 缩放控件：滚轮与拖动之外，给一组明确的按钮（触控板用户与键盘用户都用得上） */}
      <div className="flex shrink-0 items-center justify-center gap-1">
        <button
          aria-label="缩小"
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => zoomAt(scale / STEP)}
          title="缩小（-）"
          type="button"
        >
          <ZoomOutIcon className="size-4" />
        </button>
        <button
          className="min-w-14 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={reset}
          title="恢复原始大小（0）"
          type="button"
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          aria-label="放大"
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => zoomAt(scale * STEP)}
          title="放大（+）"
          type="button"
        >
          <ZoomInIcon className="size-4" />
        </button>
      </div>
    </div>
  )
}

export const ImageLightbox = ({ items, index, onIndexChange, onClose }: ImageLightboxProps) => {
  const open = index !== null && index >= 0 && index < items.length
  const current = open ? items[index] : undefined
  const hasMany = items.length > 1
  /** 可当"图片"看的那些（缩略图带只列它们；非图片在翻页语义里没有意义） */
  const imageItems = items.filter(isImageItem)
  /** "查看原图"的进行中状态（签地址是一次网络往返，按钮要能显示进度、不许重复点） */
  const [resolvingOriginal, setResolvingOriginal] = useState(false)

  const step = useCallback(
    (delta: number) => {
      if (index === null) return
      // 循环翻页：只有一张时停在原地
      const next = (index + delta + items.length) % items.length
      onIndexChange(next)
    },
    [index, items.length, onIndexChange],
  )

  /**
   * 键盘操作：左右翻页、Esc 关闭。
   *
   * 为什么自己挂 `keydown` 而不是用某个组件的快捷键系统：这是全局模态交互
   * （焦点可能在图片上、也可能刚点过按钮），挂在 window 上最可靠。
   */
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      /**
       * 焦点在输入框 / 可编辑区里时不抢方向键：非图片附件是内嵌预览
       * （文本、代码都可以在里面用方向键滚动），抢了就会"移动光标变成翻页"。
       */
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return
      if (event.key === 'ArrowLeft' && hasMany) {
        event.preventDefault()
        step(-1)
      } else if (event.key === 'ArrowRight' && hasMany) {
        event.preventDefault()
        step(1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, hasMany, step])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] w-fit max-w-[calc(100vw-2rem)] flex-col gap-3 p-3 sm:max-w-[calc(100vw-4rem)]"
        showCloseButton={false}
      >
        {/* 标题栏：文件名 + 计数 + 关闭（`DialogTitle` 是 a11y 必需的，不能省） */}
        <div className="flex shrink-0 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="truncate text-sm font-medium">
              {current?.alt || current?.caption || '图片预览'}
            </DialogTitle>
            {current?.caption && current.caption !== current.alt ? (
              <span className="shrink-0 text-xs text-muted-foreground">{current.caption}</span>
            ) : null}
            {hasMany ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {(index ?? 0) + 1} / {items.length}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {current?.onResolveOriginal ? (
              <button
                className="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                disabled={resolvingOriginal}
                onClick={() => {
                  setResolvingOriginal(true)
                  // 解析原图地址是异步动作；用同步包装保持 onClick 的 void 契约
                  void (async () => {
                    try {
                      const url = await current.onResolveOriginal?.()
                      if (url) window.open(url, '_blank', 'noopener,noreferrer')
                      else toastError('这个附件没能取到下载地址')
                    } catch (error) {
                      toastError(error instanceof Error ? error.message : String(error))
                    } finally {
                      setResolvingOriginal(false)
                    }
                  })()
                }}
                title="用有时效的下载地址打开原图（存储桶私有时的可靠路径）"
                type="button"
              >
                {resolvingOriginal ? '正在获取…' : '查看原图'}
              </button>
            ) : null}
            <button
              aria-label="关闭预览"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={onClose}
              title="关闭（Esc）"
              type="button"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        </div>

        {/* 主体区：图片走可缩放看图器，其余文件交给 `FilePreview`（PDF / 文本 / 视频…） */}
        <div className="flex min-h-0 flex-1 items-stretch justify-center gap-3">
          {hasMany ? (
            <button
              aria-label="上一张"
              className="shrink-0 rounded-full bg-muted/60 p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => step(-1)}
              title="上一张（←）"
              type="button"
            >
              <ChevronLeftIcon className="size-5" />
            </button>
          ) : null}
          {current && isImageItem(current) ? (
            <ZoomableImage alt={current.alt ?? ''} src={current.src} />
          ) : null}
          {current && !isImageItem(current) ? (
            /**
             * 非图片：复用 `FilePreview` 的类型分流（PDF / 文本走内嵌 iframe、视频音频走原生标签、
             * 认不出的类型给"打开 / 下载"兜底）—— 这份"哪类文件怎么渲染"的判断不该写两遍。
             */
            <FilePreview
              className="min-w-[70vw] rounded bg-background"
              file={{
                key: current.src,
                name: current.filename ?? current.alt ?? '附件',
                ...(current.mediaType ? { type: current.mediaType } : {}),
                ...(current.bytes === undefined ? {} : { size: current.bytes }),
              }}
              height="calc(100dvh-12rem)"
            />
          ) : null}
          {hasMany ? (
            <button
              aria-label="下一张"
              className="shrink-0 rounded-full bg-muted/60 p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => step(1)}
              title="下一张（→）"
              type="button"
            >
              <ChevronRightIcon className="size-5" />
            </button>
          ) : null}
        </div>

        {/* 多图时给一条缩略图带：一眼看到有哪些、点了直接跳（图多时比自己翻快） */}
        {imageItems.length > 1 ? (
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-2">
            {imageItems.map((item, itemIndex) => (
              <button
                key={item.id}
                aria-label={`查看第 ${itemIndex + 1} 张`}
                className={cn(
                  'size-10 overflow-hidden rounded bg-surface-2 transition-all',
                  itemIndex === index ? 'ring-1 ring-primary' : 'opacity-70 hover:opacity-100',
                )}
                onClick={() =>
                  onIndexChange(items.findIndex((candidate) => candidate.id === item.id))
                }
                type="button"
              >
                <img alt="" className="size-full object-cover" src={item.src} />
              </button>
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export interface UseImageLightboxResult {
  /**
   * 打开查看器：**把要看的这一组和当前这张一起给它**。
   *
   * 每次打开都重新给集合（而不是在 hook 里长期持有一份列表）：
   * 调用方可能有多份来源（输入框待发附件是 blob、消息里已发送的是对象存储地址、
   * 不同消息各有一组图），在点击那一刻把"这次要看的一组"交过来最短、也最不容易失配。
   */
  open: (items: readonly ImageLightboxItem[], index: number) => void
  close: () => void
  /** 把查看器挂到页面里（调用方渲染它，保证全局只有一个实例） */
  lightbox: ReactNode
}

/**
 * 免手写状态的图片查看器：调用 `open(items, index)` 看，`lightbox` 渲染到页面里。
 *
 * 交互与数据分开：集合由调用方在点击那刻给出，这里只管"看第几张"，
 * 于是两处（输入框待发附件、消息里的已发送附件）共用同一套行为（键盘翻页、缩略图带）。
 */
export const useImageLightbox = (): UseImageLightboxResult => {
  const [state, setState] = useState<{ items: ImageLightboxItem[]; index: number } | null>(null)

  return {
    open: (items, index) => setState({ items: [...items], index }),
    close: () => setState(null),
    lightbox: (
      <ImageLightbox
        index={state?.index ?? null}
        items={state?.items ?? []}
        onClose={() => setState(null)}
        onIndexChange={(next) =>
          setState((current) => (current ? { ...current, index: next } : current))
        }
      />
    ),
  }
}
