'use client'

import { useEffect, useState } from 'react'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { Extension } from '@codemirror/state'
import CodeMirror from '@uiw/react-codemirror'
import { useTheme } from '@/stores/theme.store'

/**
 * 代码 / 纯文本编辑器：`scripts/*.py`、`*.js`、`*.sh` 这类**不能走块编辑器**的文件。
 *
 * 为什么用 CodeMirror（`@uiw/react-codemirror`）而不是 textarea：
 * 脚本要的是行号、缩进、括号匹配、语法高亮 —— 这些手写不出来，成熟编辑器一次给全；
 * 为什么不用 Monaco：Monaco 是 IDE 级（~MB 级 + worker），这里只是技能目录里的几段脚本，
 * CodeMirror 6 更轻、SSR 友好、按扩展名懒加载语言包。
 *
 * 语言包不写死映射：`@codemirror/language-data` 按文件名匹配（`.py` / `.js` / `.sh` / `.yaml` …），
 * 匹配不到就当纯文本 —— 加一种脚本扩展名不用改这里。
 */
export interface CodeEditorProps {
  /** 文件相对路径（`scripts/run.py`），用于按扩展名选语言 */
  filename: string
  initialContent: string
  /** 内容变化（标脏 + 保存时取值都由父组件处理） */
  onChange: (content: string) => void
}

export function CodeEditor({ filename, initialContent, onChange }: CodeEditorProps) {
  const { dark } = useTheme()
  const [value, setValue] = useState(initialContent)
  const [language, setLanguage] = useState<Extension | null>(null)

  // 语言包按文件名懒加载（`language-data` 内部是动态 import，不匹配就是纯文本）
  useEffect(() => {
    const description = LanguageDescription.matchFilename(languages, filename)
    if (!description) {
      setLanguage(null)
      return
    }
    let alive = true
    description
      .load()
      .then((support) => {
        if (alive) setLanguage(support)
      })
      .catch(() => {
        // 语言包加载失败就退化成纯文本，不拦编辑
      })
    return () => {
      alive = false
    }
  }, [filename])

  return (
    <CodeMirror
      value={value}
      height="62vh"
      theme={dark ? 'dark' : 'light'}
      extensions={language ? [language] : []}
      placeholder="在这里写脚本内容…"
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: true,
        bracketMatching: true,
        closeBrackets: true,
        indentOnInput: true,
      }}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
      className="skill-code-editor overflow-hidden rounded-lg border border-border/60 text-[13px]"
    />
  )
}
