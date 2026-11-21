'use client'

import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@repo/ui'
import { collapsedMaxHeightOf, isOverflowing, resolveLineHeightPx } from './user-message-clamp'

/**
 * 用户消息正文（纯文本）：默认最多 10 行，超出才给「展开 / 收起」。
 *
 * 时间线里的每条用户消息与顶部吸顶条共用这一份 —— 同一段话在两处必须同一口径折叠，
 * 否则会让人以为某处丢了内容。
 *
 * `variant='sticky'`：按钮浮在右上角。吸顶条展开后可能比视口还高，按钮放在底部会滚出
 * 可视区、收不回来（用户口径是"展开不限高"，所以按钮必须钉在顶部）。
 */
export function UserMessageText({
  text,
  variant = 'inline',
}: {
  text: string
  variant?: 'inline' | 'sticky'
}) {
  const ref = useRef<HTMLParagraphElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const [maxHeight, setMaxHeight] = useState<number | null>(null)

  const measure = useCallback(() => {
    const element = ref.current
    if (!element) return
    const style = getComputedStyle(element)
    const lineHeight = resolveLineHeightPx(style.lineHeight, style.fontSize)
    setMaxHeight(collapsedMaxHeightOf(lineHeight))
    setOverflowing(isOverflowing(element.scrollHeight, lineHeight))
  }, [])

  useLayoutEffect(() => {
    measure()
    const element = ref.current
    if (!element) return
    // 宽度变化会改变换行数（窗口拉伸 / 右栏开关 / 切子 agent tab），必须重新量
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [measure, text])

  // 已经展开过就保留入口：窗口变宽后不再溢出时，用户仍可以收回去
  const collapsible = overflowing || expanded

  /** 展开 / 收起按钮：吸顶条浮在右上角（条可能比视口高），时间线里贴右下角 */
  const toggleButton = (extra: string) => (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}
      className={cn(
        'inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        extra,
      )}
    >
      {expanded ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
      {expanded ? '收起' : '展开'}
    </button>
  )

  return (
    <div className="relative space-y-1">
      <p
        ref={ref}
        className={cn(
          'break-words whitespace-pre-wrap lg:break-normal',
          !expanded && 'overflow-hidden',
          variant === 'sticky' && collapsible && 'pr-14',
        )}
        {...(expanded ? {} : { style: { maxHeight: maxHeight ?? undefined } })}
      >
        {text}
      </p>
      {collapsible ? (
        variant === 'sticky' ? (
          toggleButton('absolute top-0 right-0 bg-card/90 px-1.5 py-0.5 backdrop-blur')
        ) : (
          // 与用户消息的复制行同一侧（右侧），不打断正文的阅读起点
          <div className="flex justify-end">{toggleButton('')}</div>
        )
      ) : null}
    </div>
  )
}
