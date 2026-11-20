'use client'

import dynamic from 'next/dynamic'

/**
 * Monaco 只读预览（代码文件）。
 *
 * 动态加载（`ssr: false`）：Monaco 体积大，且只能在浏览器里跑；预览弹窗本身是懒打开的，
 * 只有点开代码文件才会拉这份 chunk。
 */
const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((mod) => mod.Editor), {
  ssr: false,
  loading: () => <div className="p-4 text-xs text-muted-foreground">正在加载编辑器…</div>,
})

/** 扩展名 → Monaco 语言 id（未命中按纯文本处理） */
const LANGUAGE_BY_EXT: Record<string, string> = {
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  go: 'go',
  graphql: 'graphql',
  gql: 'graphql',
  html: 'html',
  htm: 'html',
  java: 'java',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  jsonc: 'json',
  kt: 'kotlin',
  lua: 'lua',
  md: 'markdown',
  mdx: 'markdown',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  swift: 'swift',
  toml: 'ini',
  ini: 'ini',
  conf: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}

/** 能交给 Monaco 高亮的扩展名集合（其余走普通 `<pre>`） */
export const MONACO_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(LANGUAGE_BY_EXT))

export const isMonacoFile = (filename: string): boolean => {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return MONACO_EXTENSIONS.has(ext)
}

const languageOf = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext'
}

export function MonacoCodePreview({ filename, value }: { filename: string; value: string }) {
  return (
    <div className="h-full min-h-0 w-full">
      <MonacoEditor
        height="100%"
        language={languageOf(filename)}
        value={value}
        theme="light"
        options={{
          readOnly: true,
          domReadOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          fontSize: 11,
          lineNumbers: 'on',
          renderLineHighlight: 'none',
          contextmenu: false,
          automaticLayout: true,
          padding: { top: 12, bottom: 12 },
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        }}
      />
    </div>
  )
}
