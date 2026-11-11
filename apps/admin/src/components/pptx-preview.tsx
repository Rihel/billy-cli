'use client'

import { useEffect, useRef, useState } from 'react'
import { LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'

/**
 * PPTX 预览：动态加载 `pptx-preview`，把服务端给的 ArrayBuffer 渲染成幻灯片。
 *
 * 只处理 `.pptx`（OOXML），老 `.ppt` 不在库的支持范围，仍走下载。
 */
export function PptxPreview({
  loadBytes,
  filename,
}: {
  loadBytes: () => Promise<ArrayBuffer>
  filename: string
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const loadRef = useRef(loadBytes)
  loadRef.current = loadBytes
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    let previewer: { destroy: () => void } | null = null
    setStatus('loading')
    setError('')

    const render = async () => {
      try {
        const buffer = await loadRef.current()
        const module = await import('pptx-preview')
        if (cancelled || !hostRef.current) return
        hostRef.current.innerHTML = ''
        previewer = module.init(hostRef.current, { width: 960, height: 540, mode: 'list' })
        await (previewer as unknown as { preview: (data: ArrayBuffer) => Promise<unknown> }).preview(
          buffer,
        )
        if (!cancelled) setStatus('ready')
      } catch (cause) {
        if (cancelled) return
        setStatus('error')
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }

    void render()
    return () => {
      cancelled = true
      previewer?.destroy()
      if (hostRef.current) hostRef.current.innerHTML = ''
    }
  }, [filename])

  return (
    <div className="relative h-full w-full overflow-auto">
      {status === 'loading' ? (
        <div className="flex h-full min-h-40 items-center justify-center gap-2 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" />
          正在渲染 PPTX…
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
          <TriangleAlertIcon className="size-5 text-warning" />
          <span>PPTX 渲染失败，请下载查看。</span>
          <span className="break-all text-[11px] opacity-70">{error}</span>
        </div>
      ) : null}
      <div ref={hostRef} className="mx-auto w-fit" />
    </div>
  )
}
