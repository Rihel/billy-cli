"use client"

import { Button } from "#components/ui/button.tsx"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "#components/ui/dialog.tsx"
import { cn } from "#lib/utils.ts"
import { Maximize2Icon } from "lucide-react"
import { lazy, Suspense, useMemo, useState } from "react"
import type { CustomRendererProps } from "streamdown"

import { FenceError, FencePending, FenceSource } from "./fence-chrome.tsx"
import { parseXflowSpec } from "./fence-spec.ts"

/** 会话里的画布高度区间：太矮看不清结构，太高占满一屏 */
const CANVAS_MIN_HEIGHT = 220
const CANVAS_MAX_HEIGHT = 420

const XflowCanvas = lazy(() =>
  import("./xflow-canvas.tsx").then((module) => ({ default: module.XflowCanvas })),
)

const CanvasSkeleton = ({ className, height }: { className?: string; height?: number }) => (
  <div
    className={cn("flex w-full items-center justify-center rounded-lg border border-border bg-sidebar", className)}
    style={height === undefined ? undefined : { height }}
  >
    <span className="text-muted-foreground text-xs">正在加载画布…</span>
  </div>
)

/**
 * ```` ```xflow ```` 围栏：模型给"谁连谁"，前端负责排版。
 *
 * 为什么不让模型写坐标：算坐标既费 token，又几乎一定会重叠。这里是纯数据 +
 * 确定的排版算法（见 `layoutXflow`），同一份 JSON 每次画出来都一样，可单测。
 *
 * 会话里的那张图是缩略尺寸（220–420px），节点一多就只能靠缩放猜；所以另开一个**全屏**入口：
 * 整屏画布 + 可拖动画布 + 缩放控件。两处用的是同一个画布组件，只是模式不同。
 */
export const XflowFence = ({ code, isIncomplete, language }: CustomRendererProps) => {
  const parsed = useMemo(() => parseXflowSpec(code), [code])
  const [fullscreen, setFullscreen] = useState(false)
  // 真实内容高度由画布排版后回报；拿到之前先给一个中庸值，避免容器忽高忽低
  const [contentHeight, setContentHeight] = useState<number | null>(null)

  if (isIncomplete) {
    return <FencePending language={language} />
  }

  if (!parsed.ok) {
    return (
      <div data-fence="xflow">
        <FenceError language="xflow" message={parsed.error} />
        <FenceSource code={code} label="原始 JSON" />
      </div>
    )
  }

  const { model } = parsed
  const height = Math.min(
    CANVAS_MAX_HEIGHT,
    Math.max(CANVAS_MIN_HEIGHT, (contentHeight ?? 240) + 48),
  )
  const title = model.title ?? "流程图"

  return (
    <div className="my-4" data-fence="xflow">
      <div className="mb-2 flex items-center gap-2">
        {model.title ? (
          <p className="min-w-0 flex-1 truncate font-medium text-sm text-foreground">{model.title}</p>
        ) : (
          <span className="flex-1" />
        )}
        <Button
          aria-label="全屏查看流程图"
          className="shrink-0 text-muted-foreground"
          onClick={() => setFullscreen(true)}
          size="sm"
          variant="ghost"
        >
          <Maximize2Icon />
          全屏
        </Button>
      </div>

      <Suspense fallback={<CanvasSkeleton height={height} />}>
        <XflowCanvas
          direction={model.direction}
          edges={model.edges}
          height={height}
          nodes={model.nodes}
          onContentSize={(size) => setContentHeight(size.height)}
        />
      </Suspense>
      {/* 画出来的图**就是**数据，不再附一段原始 JSON：那是纯噪音（想看数据就关掉渲染，或复制节点结论） */}
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent
          bodyScroll={false}
          className="flex h-[92dvh] w-[96vw] max-w-[96vw] flex-col p-0 sm:max-w-[96vw]"
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 px-3 pb-3">
            <Suspense fallback={<CanvasSkeleton className="h-full" />}>
              <XflowCanvas
                direction={model.direction}
                edges={model.edges}
                fill
                interactive
                nodes={model.nodes}
              />
            </Suspense>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
