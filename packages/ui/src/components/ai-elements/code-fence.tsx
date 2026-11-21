'use client'

import { Button } from '#components/ui/button.tsx'
import { cn } from '#lib/utils.ts'
import { CheckIcon, CopyIcon, DownloadIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'

type EditorComponent = ComponentType<Record<string, unknown>>

/** 主题：跟 JsonView 同一套 token，代码块不再是"编辑器风" */
const buildTheme = (view: typeof import('@codemirror/view')) =>
  view.EditorView.theme({
    '&': { backgroundColor: 'transparent', color: 'var(--foreground)', fontSize: '12px' },
    '.cm-content': { fontFamily: 'var(--font-mono)', padding: '10px 0' },
    '.cm-gutters': { display: 'none' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-scroller': { lineHeight: '1.65' },
  })

/**
 * 普通代码围栏（非自定义渲染的那几种）：CodeMirror 只读 + 语言高亮。
 *
 * 操作项（复制 / 下载）放**右下角**、hover 才出现；语言标识留在左上角。
 */
export function CodeFence({
  code,
  language,
  className,
}: {
  code: string
  language: string
  className?: string
}) {
  const [Editor, setEditor] = useState<EditorComponent | null>(null)
  const [extensions, setExtensions] = useState<unknown[]>([])
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [codemirror, data, languageApi, view, state] = await Promise.all([
        import('@uiw/react-codemirror'),
        import('@codemirror/language-data'),
        import('@codemirror/language'),
        import('@codemirror/view'),
        import('@codemirror/state'),
      ])
      const description = languageApi.LanguageDescription.matchLanguageName(
        data.languages,
        language,
        true,
      )
      const support = description ? await description.load() : []
      if (!alive) return
      setExtensions([
        support,
        buildTheme(view),
        state.EditorState.readOnly.of(true),
        view.EditorView.lineWrapping,
      ])
      setEditor(() => codemirror.default as unknown as EditorComponent)
    })().catch(() => undefined)
    return () => {
      alive = false
    }
  }, [language])

  const copy = useCallback(() => {
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1200)
    })
  }, [code])

  const download = useCallback(() => {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `snippet.${language || 'txt'}`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [code, language])

  return (
    <div
      className={cn(
        'group relative my-3 overflow-hidden rounded-lg border border-border bg-sidebar',
        className,
      )}
      data-code-fence={language}
    >
      <div className="px-3 pt-2 font-mono text-[11px] text-muted-foreground lowercase">
        {language || 'text'}
      </div>
      <div className="overflow-auto" style={{ maxHeight: 420 }}>
        {Editor ? (
          <Editor
            height="auto"
            theme="none"
            editable={false}
            basicSetup={{ lineNumbers: false, foldGutter: true, highlightActiveLine: false }}
            extensions={extensions}
            value={code}
          />
        ) : (
          <pre className="overflow-auto p-3 font-mono text-[12px] leading-relaxed">
            <code>{code}</code>
          </pre>
        )}
      </div>
      <div className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-1 rounded-md bg-surface-2 p-0.5 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        <Button aria-label="下载代码" size="sm" variant="ghost" onClick={download}>
          <DownloadIcon className="size-3.5" />
        </Button>
        <Button aria-label="复制代码" size="sm" variant="ghost" onClick={copy}>
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </Button>
      </div>
    </div>
  )
}

/** 普通围栏以外的 `pre` 兜底（防御性保留原始输出） */
export const PlainPre = ({ children }: { children: React.ReactNode }) => (
  <pre className="my-3 overflow-auto rounded-lg border border-border p-3 font-mono text-[12px]">
    {children}
  </pre>
)

export const CODE_FENCE_LANGUAGES = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'python',
  'bash',
  'sh',
  'sql',
  'yaml',
  'go',
  'rust',
] as const
