"use client"

import { Button } from "#components/ui/button.tsx"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "#components/ui/dialog.tsx"
import { cn } from "#lib/utils.ts"
import { Maximize2Icon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { buildSandboxDocument, type SandboxTheme } from "./fence-spec.ts"

/**
 * 同源脚本的取回缓存。
 *
 * 内联进 iframe 的脚本（目前只有内置 gsap）由父页面取一次、所有围栏共用：
 * iframe 自己连不出去（沙箱内 CSP 禁止外链），所以必须由父页面代取。
 */
const scriptCache = new Map<string, Promise<string>>()

const loadScriptSource = (url: string): Promise<string> => {
  const cached = scriptCache.get(url)
  if (cached) return cached
  const pending = fetch(url, { credentials: 'omit' }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`取不到 ${url}（HTTP ${response.status}）`)
    }
    return response.text()
  })
  scriptCache.set(url, pending)
  // 取失败不占坑：下次重渲染还能再试
  pending.catch(() => scriptCache.delete(url))
  return pending
}

export interface SandboxFrameProps {
  /** 模型写的 HTML 片段 */
  html: string
  /** 需要内联的脚本地址（同源相对路径），按顺序执行 */
  scripts?: string[]
  /** 无障碍标题，同时用作 iframe 的 title */
  title: string
  /** 语言标识，显示在头部（html / gsap） */
  language: string
  className?: string
  minHeight?: number
  maxHeight?: number
}

const DEFAULT_MIN_HEIGHT = 160
const DEFAULT_MAX_HEIGHT = 560

/** 透明的底色在 iframe 里会变成白底（画布默认白），深色页面里就是一块刺眼的白 */
const isTransparent = (value: string): boolean =>
  value === '' || value === 'transparent' || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(value)

/**
 * 父页面当前主题的底色与字色：沙箱里没有父页面的 CSS，只能把这两个值传进去。
 *
 * 依次看 `body` → `html`，都透明时给白色兜底 —— 宁可和浅色主题一致，也不要一块透明画布。
 */
const readTheme = (): SandboxTheme => {
  if (typeof window === 'undefined') {
    return { background: '#ffffff', color: '#111111' }
  }
  const bodyStyle = window.getComputedStyle(document.body)
  const rootStyle = window.getComputedStyle(document.documentElement)
  const background = [bodyStyle.backgroundColor, rootStyle.backgroundColor].find(
    (value) => !isTransparent(value),
  )
  const color = [bodyStyle.color, rootStyle.color].find((value) => !isTransparent(value))
  return {
    background: background ?? '#ffffff',
    color: color ?? '#111111',
  }
}

/**
 * 沙箱 iframe：模型写的 HTML / 脚本在这里跑，但拿不到后台页面的任何权限。
 *
 * 三条边界：
 * 1. `sandbox="allow-scripts"`（**不带** `allow-same-origin`）—— 不透明源，读不到父页面 DOM / cookie / storage；
 * 2. 文档内 CSP `default-src 'none'` —— 连不出去（外链脚本、fetch、表单、嵌套框架全禁）；
 * 3. 高度由框内 `ResizeObserver` 回报，父页面只认自己这个 iframe 发的消息。
 */
export const SandboxFrame = ({
  html,
  scripts = [],
  title,
  language,
  className,
  minHeight = DEFAULT_MIN_HEIGHT,
  maxHeight = DEFAULT_MAX_HEIGHT,
}: SandboxFrameProps) => {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = useState(minHeight)
  const [sources, setSources] = useState<string[] | null>(scripts.length === 0 ? [] : null)
  const [scriptError, setScriptError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const [srcdoc, setSrcdoc] = useState('')

  const scriptKey = scripts.join('|')

  useEffect(() => {
    if (scripts.length === 0) {
      setSources([])
      return
    }
    let cancelled = false
    setSources(null)
    setScriptError(null)
    void Promise.all(scripts.map(loadScriptSource))
      .then((loaded) => {
        if (!cancelled) setSources(loaded)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setScriptError(error instanceof Error ? error.message : '脚本加载失败')
        setSources([])
      })
    return () => {
      cancelled = true
    }
    // scriptKey 已经把这些地址拼成稳定依赖，避免每次渲染都重新取
  }, [scriptKey, scripts.length])

  useEffect(() => {
    if (sources === null) return
    setSrcdoc(buildSandboxDocument({ html, scripts: sources, theme: readTheme() }))
  }, [html, sources, reloadKey])

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const payload = event.data
      if (typeof payload !== 'object' || payload === null) return
      const reported = (payload as { __fenceHeight?: unknown }).__fenceHeight
      if (typeof reported !== 'number' || !Number.isFinite(reported)) return
      setHeight(Math.min(maxHeight, Math.max(minHeight, Math.ceil(reported))))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [minHeight, maxHeight])

  const reload = useCallback(() => setReloadKey((key) => key + 1), [])

  const header = useMemo(
    () => (
      <div className="flex h-8 items-center justify-between gap-2 text-muted-foreground text-xs">
        <span className="ml-1 font-mono lowercase">{language}</span>
        <div className="flex items-center gap-1">
          <Button
            aria-label="全屏查看"
            className="text-muted-foreground"
            onClick={() => setFullscreen(true)}
            size="sm"
            variant="ghost"
          >
            <Maximize2Icon />
            全屏
          </Button>
          <Button
            aria-label="重新运行"
            className="text-muted-foreground"
            onClick={reload}
            size="sm"
            variant="ghost"
          >
            <RefreshCwIcon />
            重跑
          </Button>
        </div>
      </div>
    ),
    [language, reload],
  )

  if (scriptError) {
    return (
      <div className={cn('my-4 rounded-xl border border-border bg-sidebar p-3', className)}>
        <p className="flex items-center gap-2 text-destructive text-sm">
          <TriangleAlertIcon size={14} />
          沙箱运行环境没准备好：{scriptError}
        </p>
      </div>
    )
  }

  return (
    <div className={cn('my-4 w-full rounded-xl border border-border bg-sidebar p-2', className)}>
      {header}
      {srcdoc ? (
        <iframe
          className="w-full rounded-lg border-0 bg-transparent"
          ref={frameRef}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts"
          srcDoc={srcdoc}
          style={{ height }}
          title={title}
        />
      ) : (
        <div className="flex w-full items-center justify-center text-muted-foreground text-xs" style={{ height }}>
          正在准备沙箱…
        </div>
      )}

      {/* 全屏用的是**另一份**文档（同一份 srcdoc、另一个 iframe）：脚本会从头再跑一遍，
          这正是"重看一遍动画"的预期；沙箱参数与内联那份完全一致，没有放宽任何权限。 */}
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent
          bodyScroll={false}
          className="flex h-[92dvh] w-[96vw] max-w-[96vw] flex-col p-0 sm:max-w-[96vw]"
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 px-3 pb-3">
            {srcdoc ? (
              <iframe
                className="h-full w-full rounded-lg border-0 bg-transparent"
                referrerPolicy="no-referrer"
                sandbox="allow-scripts"
                srcDoc={srcdoc}
                title={`${title}（全屏）`}
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
