'use client'

import { useEffect, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { Button } from '@repo/ui'

export type OfficeKind = 'docx' | 'xlsx' | 'pptx'

type SheetData = { name: string; rows: unknown[][] }

/**
 * Office 文件预览（DOCX / XLSX / XLS / PPTX）。
 *
 * 三类都只吃 ArrayBuffer：字节由调用方通过对象存储直链 fetch（或工作区临时链接）拿到，
 * 这里只负责把文件流交给第三方渲染器，不经过后端下载转发。
 * 老 `.doc` / `.ppt` 不在库支持范围，仍由调用方走下载兜底。
 */
export function OfficePreview({
  kind,
  loadBytes,
  filename,
}: {
  kind: OfficeKind
  loadBytes: () => Promise<ArrayBuffer>
  filename: string
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const loadRef = useRef(loadBytes)
  loadRef.current = loadBytes
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [sheets, setSheets] = useState<SheetData[] | null>(null)
  const previewerRef = useRef<{ renderSingleSlide: (index: number) => void } | null>(null)
  const [slideIndex, setSlideIndex] = useState(0)
  const [slideCount, setSlideCount] = useState(0)

  useHotkeys(
    'left',
    () => {
      const next = Math.max(0, slideIndex - 1)
      if (next === slideIndex) return
      previewerRef.current?.renderSingleSlide(next)
      setSlideIndex(next)
    },
    { enabled: kind === 'pptx' && slideCount > 1 && slideIndex > 0, preventDefault: true },
    [kind, slideCount, slideIndex],
  )
  useHotkeys(
    'right',
    () => {
      const next = Math.min(slideCount - 1, slideIndex + 1)
      if (next === slideIndex) return
      previewerRef.current?.renderSingleSlide(next)
      setSlideIndex(next)
    },
    {
      enabled: kind === 'pptx' && slideCount > 1 && slideIndex < slideCount - 1,
      preventDefault: true,
    },
    [kind, slideCount, slideIndex],
  )

  useEffect(() => {
    // 在 effect 入口捕获容器：cleanup 里不再直接读 ref.current（此时可能已卸载 / 指向新节点）
    const host = hostRef.current
    let cancelled = false
    let previewer: { destroy: () => void } | null = null
    setStatus('loading')
    setError('')
    setSheets(null)
    setSlideCount(0)
    setSlideIndex(0)
    previewerRef.current = null

    const render = async () => {
      try {
        const buffer = await loadRef.current()
        if (kind === 'xlsx') {
          const XLSX = await import('xlsx')
          const workbook = XLSX.read(buffer, { type: 'array' })
          const next = workbook.SheetNames.map((name) => ({
            name,
            rows: XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name]!, {
              header: 1,
              raw: false,
              defval: '',
            }) as unknown[][],
          }))
          if (!cancelled) {
            setSheets(next)
            setStatus('ready')
          }
          return
        }

        if (!host) return
        host.innerHTML = ''
        if (kind === 'pptx') {
          const pptxPreview = await import('pptx-preview')
          // 不用 preview()：它内部在 slide 模式下会自己再渲染一遍，实测会出现两层/两页。
          // 这里 load 后手动 renderSingleSlide，一次只保留一页，翻页由下面的按钮控制。
          const available = host.parentElement?.clientWidth ?? 960
          const width = Math.max(640, Math.min(1400, available - 24))
          // 用 list 布局手动 renderSingleSlide：slide 模式会按 viewPort.height 居中，
          // 固定 height 会在上方/下方留出一条黑色空白；list 的 slide wrapper 是 relative，
          // 高度跟内容走，配合手动单页就是“一页铺满”。
          const instance = pptxPreview.init(host, { width, mode: 'list' })
          previewer = instance
          previewerRef.current = instance as unknown as {
            renderSingleSlide: (index: number) => void
          }
          await instance.load(buffer)
          if (!cancelled) {
            setSlideCount(instance.slideCount)
            setSlideIndex(0)
            instance.renderSingleSlide(0)
          }
        } else {
          const { renderAsync } = await import('docx-preview')
          await renderAsync(buffer, host, undefined, {
            className: 'docx-preview',
            // 自适应宽度：忽略原页面宽高、不强制分页，内容直接铺满右侧容器
            inWrapper: false,
            ignoreWidth: true,
            ignoreHeight: true,
            breakPages: false,
          })
        }
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
      if (host) host.innerHTML = ''
    }
  }, [kind, filename])

  return (
    <div className="flex h-full w-full flex-col">
      <div className="relative min-h-0 flex-1 overflow-auto">
        {status === 'loading' ? (
          <div className="flex h-full min-h-40 items-center justify-center gap-2 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-4 animate-spin" />
            正在渲染 {filename}…
          </div>
        ) : null}
        {status === 'error' ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
            <TriangleAlertIcon className="size-5 text-warning" />
            <span>Office 渲染失败，请下载查看。</span>
            <span className="break-all text-[11px] opacity-70">{error}</span>
          </div>
        ) : null}
        <div ref={hostRef} className={kind === 'docx' ? 'w-full' : 'mx-auto w-fit'} />
        {kind === 'xlsx' && sheets ? (
          <div className="flex flex-col gap-5 pb-6">
            {sheets.map((sheet) => (
              <section key={sheet.name} className="flex flex-col gap-2">
                <h3 className="sticky top-0 z-10 bg-background px-1 py-1 text-xs font-medium">
                  {sheet.name}
                </h3>
                <div className="overflow-auto rounded border">
                  <table className="w-full border-collapse text-xs">
                    <tbody>
                      {sheet.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {row.map((cell, cellIndex) => (
                            <td
                              key={cellIndex}
                              className="max-w-80 truncate border border-border px-2 py-1 align-top"
                              title={String(cell ?? '')}
                            >
                              {String(cell ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        ) : null}
      </div>

      {kind === 'pptx' && slideCount > 1 ? (
        <div className="flex shrink-0 justify-center border-t bg-background/95 px-3 py-2">
          <div className="flex items-center gap-2 rounded-full border bg-background px-2 py-1 shadow-sm">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="上一页（←）"
              title="上一页（←）"
              disabled={slideIndex <= 0}
              onClick={() => {
                const next = Math.max(0, slideIndex - 1)
                previewerRef.current?.renderSingleSlide(next)
                setSlideIndex(next)
              }}
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <span className="min-w-14 text-center text-xs tabular-nums text-muted-foreground">
              {slideIndex + 1} / {slideCount}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="下一页（→）"
              title="下一页（→）"
              disabled={slideIndex >= slideCount - 1}
              onClick={() => {
                const next = Math.min(slideCount - 1, slideIndex + 1)
                previewerRef.current?.renderSingleSlide(next)
                setSlideIndex(next)
              }}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
