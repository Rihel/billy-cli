'use client'

import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { useTheme } from '@/stores/theme.store'

/**
 * **类 Notion 的块编辑器**（BlockNote）—— 技能 Markdown 的写作界面。
 *
 * 三条设计：
 * - **只编辑正文**：`SKILL.md` 的 YAML frontmatter 由表单字段（标题 / description）维护，
 *   不进编辑器 —— 块编辑器会把 Markdown 归一化（列表符号、空行、转义），
 *   拿它往返 YAML 迟早改坏 frontmatter；
 * - **非受控 + 命令式取值**：每次击键都把整篇转成 Markdown 太贵，保存时由父组件调
 *   `ref.getMarkdown()` 取一次；`onChange` 只用来标脏；
 * - **只在客户端加载**：BlockNote 依赖浏览器 API，调用方用 `dynamic(..., { ssr: false })` 引入。
 *
 * 转换是 **lossy** 的（BlockNote 自己的命名）：它保留内容与结构，但不保证原样保留
 * 手写的空行 / 列表符号 / HTML 注释 —— 对"给人读的说明文档"够用，对逐字节保真不够。
 * 需要逐字节控制的文件（脚本）走代码编辑器，不走这里。
 */
export interface NotionEditorHandle {
  /** 取当前内容的 Markdown（保存时调用） */
  getMarkdown: () => string
  /** 用 Markdown 覆盖编辑器内容（保存后服务端归一化过的话用它回填） */
  setMarkdown: (markdown: string) => void
}

export interface NotionEditorProps {
  /** 初始 Markdown（只在挂载时读一次；切换文件请让父组件换 `key`） */
  initialMarkdown: string
  /** 只读模式（预留：技能内容目前都可编辑） */
  editable?: boolean
  /** 空文档时的提示（默认一句中文，别让用户看到 BlockNote 的英文占位） */
  placeholder?: string
  /** 内容变化（用来标脏，不做转换） */
  onChange?: () => void
  ref?: Ref<NotionEditorHandle>
}

/**
 * Markdown → blocks 并替换文档。
 *
 * 空内容**不能** replaceBlocks（BlockNote 不接受空数组；新建的参考文件就是空内容），
 * 直接保留初始的空段落即可。
 */
const applyMarkdown = (editor: ReturnType<typeof useCreateBlockNote>, markdown: string): void => {
  const blocks = editor.tryParseMarkdownToBlocks(markdown)
  if (blocks.length === 0) return
  editor.replaceBlocks(editor.document, blocks)
}

export function NotionEditor({
  initialMarkdown,
  placeholder = '开始写…',
  editable = true,
  onChange,
  ref,
}: NotionEditorProps) {
  const { dark } = useTheme()
  const editor = useCreateBlockNote({
    // `placeholders` 在 0.57 里被标了 deprecated（推荐 dictionary），但字典结构随版本变；
    // 这里只需要"空段落的一句中文提示"，用这个入口最稳。
    placeholders: { default: placeholder },
  })
  const [ready, setReady] = useState(false)
  const loaded = useRef(false)
  // 初次把 Markdown 灌进编辑器也是一次文档变更：不捂住它，页面一打开就是"未保存"
  const suppressChange = useRef(true)

  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    applyMarkdown(editor, initialMarkdown)
    setReady(true)
    const timer = setTimeout(() => {
      suppressChange.current = false
    }, 0)
    return () => clearTimeout(timer)
  }, [editor, initialMarkdown])

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => editor.blocksToMarkdownLossy(editor.document),
      setMarkdown: (markdown) => applyMarkdown(editor, markdown),
    }),
    [editor],
  )

  return (
    <div className="min-h-[60vh] w-full [&_.bn-container]:bg-transparent [&_.bn-editor]:bg-transparent">
      {!ready ? (
        <div className="py-10 text-center text-sm text-muted-foreground">正在渲染编辑器…</div>
      ) : null}
      <BlockNoteView
        editor={editor}
        theme={dark ? 'dark' : 'light'}
        editable={editable}
        slashMenu
        onChange={() => {
          if (!suppressChange.current) onChange?.()
        }}
      />
    </div>
  )
}
