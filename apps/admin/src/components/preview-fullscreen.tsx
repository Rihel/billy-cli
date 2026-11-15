'use client'

import { useCallback, useState } from 'react'
import { Maximize2Icon, Minimize2Icon } from 'lucide-react'
import { useHotkeys } from 'react-hotkeys-hook'
import { Button, cn } from '@repo/ui'

/**
 * 预览的「全屏」交互，文件预览弹窗（`FilePreviewDialog`）与分享页（`SharePreview`）共用。
 *
 * 口径：全屏 = 把两侧 chrome 收掉、只留内容 —— 弹窗收侧栏 / 顶栏 / 底栏，分享页收顶栏。
 * 进入走头部的「全屏」按钮（快捷键 `f`），退出走右上角悬浮按钮。
 * `Esc` 的归属按场景分：弹窗里由 `Dialog` 的 `onOpenChange` 先拦一道（见 `FilePreviewDialog`，
 * reason 是 `escape-key` 时只退全屏、不关窗），分享页没有弹窗，自己监听 `escape`。
 */
export function usePreviewFullscreen(enabled = true) {
  const [fullscreen, setFullscreen] = useState(false)
  const toggle = useCallback(() => setFullscreen((current) => !current), [])
  const exit = useCallback(() => setFullscreen(false), [])

  // 弹窗关着时不挂快捷键：否则在列表页按 f 会改掉一个看不见的状态，下次打开直接是全屏
  useHotkeys('f', toggle, { enabled, preventDefault: true })

  return { fullscreen, toggle, exit }
}

/** 头部「全屏」入口：和上一个 / 下一个、下载这些操作并排 */
export function FullscreenButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" onClick={onClick} title="全屏（F）" aria-label="全屏">
      <Maximize2Icon className="size-4" />
    </Button>
  )
}

/**
 * 全屏态右上角的悬浮「退出全屏」。
 *
 * 内容可能是任意颜色（黑色视频、白底文档、HTML 页面），所以自带一层半透明底 + 细投影，
 * 不靠内容给对比度；`className` 决定吸附位置（弹窗里要让开内置的关闭键）。
 */
export function FullscreenExitButton({
  onClick,
  className,
}: {
  onClick: () => void
  className?: string
}) {
  return (
    <Button
      variant="outline"
      size="icon-sm"
      onClick={onClick}
      title="退出全屏（F）"
      aria-label="退出全屏"
      className={cn('rounded-full bg-background/90 shadow-sm backdrop-blur', className)}
    >
      <Minimize2Icon className="size-4" />
    </Button>
  )
}
