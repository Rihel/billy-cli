'use client'

import { Button } from '#components/ui/button.tsx'
import { cn } from '#lib/utils.ts'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

/**
 * JSON 查看器：把一段 JSON 渲染成可折叠的树，而不是一大块高亮代码。
 *
 * 实现：**只读 Monaco**（本地资源 `/monaco/vs`，由 admin 的 `copy-monaco.mjs` 拷贝）。
 * 之前手写的折叠树 DOM 在深嵌套 / 宽对象上既丑又卡，交给 Monaco 后用统一的高亮、折叠、
 * 查找与横向滚动。
 *
 * 保持两条克制：
 * - **只读**：不允许编辑，避免"预览里改坏数据"；
 * - **有上限**：超过 200KB / 2000 条时退回码块原文并说明（Monaco 渲染超大文本同样会卡）。
 */

/** 超过这个长度的原文不做树形渲染（解析本身没问题，是 DOM 撑不住） */
const MAX_TREE_TEXT_LENGTH = 200_000
/** 超过这个条目数不做树形渲染 */
const MAX_TREE_ENTRIES = 2_000
/** 单行字符串的默认截断长度，点一下可以展开 */
const STRING_PREVIEW_LENGTH = 120

export type JsonValueKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object'

export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: string }

/** 解析 JSON 文本：失败时给出可读原因（带上位置），不抛错 */
export const parseJsonText = (text: string): JsonParseResult => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}

/** 值的类型标签（树里决定怎么画、摘要怎么拼） */
export const jsonValueKind = (value: unknown): JsonValueKind => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'object':
      return 'object'
    default:
      // undefined / function / symbol 不是合法 JSON，兜底按 null 处理
      return 'null'
  }
}

/** 是不是容器（对象或数组）：只有容器才有折叠 */
export const isJsonContainer = (value: unknown): value is Record<string, unknown> | unknown[] => {
  const kind = jsonValueKind(value)
  return kind === 'object' || kind === 'array'
}

/** 容器/字符串的一行摘要，例如 `{4 个字段}`、`[3 项]`、`"https://…"` */
export const summarizeJsonValue = (value: unknown, limit = STRING_PREVIEW_LENGTH): string => {
  const kind = jsonValueKind(value)
  if (kind === 'array') return `[${(value as unknown[]).length} 项]`
  if (kind === 'object') return `{${Object.keys(value as Record<string, unknown>).length} 个字段}`
  if (kind === 'string') {
    const text = value as string
    const single = text.replace(/\s+/g, ' ').trim()
    return single.length > limit ? `${single.slice(0, limit)}…` : single
  }
  if (kind === 'null') return 'null'
  return String(value)
}

/** 条目总数（含嵌套），数到 `limit` 就停 —— 用来决定"能不能做成树"，不必数清全量 */
export const countJsonEntries = (value: unknown, limit = MAX_TREE_ENTRIES): number => {
  let count = 0
  const walk = (node: unknown): boolean => {
    if (!isJsonContainer(node)) return true
    const children = Array.isArray(node) ? node : Object.values(node)
    for (const child of children) {
      count += 1
      // 到达上限就停：这里只需要"是否超限"这一个结论，不必数清全部
      if (count >= limit) return false
      if (!walk(child)) return false
    }
    return true
  }
  walk(value)
  return count
}

/** 格式化：能 stringify 就缩进 2 格，不能（循环引用等）就退回 String */
export const formatJsonValue = (value: unknown): string => {
  try {
    const text = JSON.stringify(value, null, 2)
    return text ?? String(value)
  } catch {
    return String(value)
  }
}

export interface JsonViewProps {
  /** 已经解析好的值（与 `text` 二选一，同时给时以 `value` 为准） */
  value?: unknown
  /** 原始 JSON 文本：解析失败时按原文展示并说明原因 */
  text?: string
  /** @deprecated 固定按"根 + 第一层展开"渲染，保留仅为 API 兼容 */
  defaultExpandDepth?: number
  /** 最大高度（px），超出滚动，默认 420 */
  maxHeight?: number
  className?: string
}

/** 折叠态的行内预览条数（借鉴 DSH JsonTree 的口径：对象 4 项、数组 5 项） */
const PREVIEW_OBJECT = 4
const PREVIEW_ARRAY = 5
/** 默认展开的层数：根 + 第一层（再深就折叠，避免一屏全是数据） */
const DEFAULT_OPEN_DEPTH = 1
const STRING_PREVIEW = 120

/** 配色全部走整站 token，不做硬编码色板 */
const TREE_STYLE = {
  '--json-tree-key': 'var(--info)',
  '--json-tree-string': 'var(--muted-foreground)',
  '--json-tree-number': 'var(--foreground)',
  '--json-tree-keyword': 'var(--warning)',
  '--json-tree-punct': 'var(--muted-foreground)',
} as React.CSSProperties

/** 单行内边距：每层 14px；chevron 槽固定 12px，保证不同行（有无 chevron）的键对齐 */
const INDENT = 14
const GUTTER = 12

const JsonValueText = ({ value }: { value: unknown }) => {
  const kind = jsonValueKind(value)
  const [expanded, setExpanded] = useState(false)
  if (kind === 'string') {
    const raw = value as string
    if (raw.length > STRING_PREVIEW && !expanded) {
      return (
        <span className="min-w-0 flex-1 break-all" style={{ color: 'var(--json-tree-string)' }}>
          {JSON.stringify(raw.slice(0, STRING_PREVIEW))}…
          <button
            type="button"
            className="ml-1 text-muted-foreground text-xs underline underline-offset-2"
            onClick={() => setExpanded(true)}
          >
            展开
          </button>
        </span>
      )
    }
    return (
      <span className="min-w-0 flex-1 break-all" style={{ color: 'var(--json-tree-string)' }}>
        {JSON.stringify(raw)}
      </span>
    )
  }
  if (kind === 'boolean' || kind === 'null') {
    return <span style={{ color: 'var(--json-tree-keyword)' }}>{String(value)}</span>
  }
  if (kind === 'number') {
    return <span style={{ color: 'var(--json-tree-number)' }}>{String(value)}</span>
  }
  return <span>{String(value)}</span>
}

const Row = ({
  depth,
  gutter,
  label,
  children,
}: {
  depth: number
  gutter?: React.ReactNode
  label?: string
  children: React.ReactNode
}) => (
  <div
    className="flex min-w-0 items-start gap-1 py-0.5 text-left"
    style={{ paddingLeft: depth * INDENT }}
  >
    <span className="mt-0.5 flex w-3 shrink-0 justify-center">{gutter}</span>
    {label === undefined ? null : (
      <span className="shrink-0" style={{ color: 'var(--json-tree-key)' }}>
        {label}:
      </span>
    )}
    {children}
  </div>
)

const JsonNode = ({
  label,
  value,
  depth,
  arrayIndex,
}: {
  label?: string
  value: unknown
  depth: number
  arrayIndex?: number
}) => {
  const [open, setOpen] = useState(depth <= DEFAULT_OPEN_DEPTH)
  const container = isJsonContainer(value)
  const entries = useMemo(
    () => (container ? Object.entries(value as Record<string, unknown>) : []),
    [container, value],
  )
  const shownLabel = arrayIndex === undefined ? label : String(arrayIndex)

  if (!container) {
    return (
      <Row depth={depth} label={shownLabel}>
        <JsonValueText value={value} />
      </Row>
    )
  }

  const isArray = Array.isArray(value)
  const preview = entries.slice(0, isArray ? PREVIEW_ARRAY : PREVIEW_OBJECT)
  const rest = entries.length - preview.length
  return (
    <div className="min-w-0">
      <Row
        depth={depth}
        label={shownLabel}
        gutter={
          <button
            type="button"
            aria-label={open ? '收起' : '展开'}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((previous) => !previous)}
          >
            {open ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronRightIcon className="size-3" />
            )}
          </button>
        }
      >
        <span style={{ color: 'var(--json-tree-punct)' }}>{isArray ? '[' : '{'}</span>
        {open ? null : (
          <span className="text-muted-foreground text-xs">
            {entries.length} {isArray ? '项' : '个字段'}
            {rest > 0 ? `，还有 ${rest} 项` : ''}
          </span>
        )}
        {open ? null : (
          <span style={{ color: 'var(--json-tree-punct)' }}>{isArray ? ']' : '}'}</span>
        )}
      </Row>
      {open ? (
        <>
          {entries.map(([key, child]) => (
            <JsonNode
              key={key}
              label={isArray ? undefined : key}
              arrayIndex={isArray ? Number(key) : undefined}
              value={child}
              depth={depth + 1}
            />
          ))}
          {/* 收尾括号与起始括号对齐：缩进 + chevron 槽，而不是写死 12 */}
          <div
            className="py-0.5"
            style={{ paddingLeft: depth * INDENT + GUTTER + 4, color: 'var(--json-tree-punct)' }}
          >
            {isArray ? ']' : '}'}
          </div>
        </>
      ) : null}
    </div>
  )
}

/** 只读 JSON 树（借鉴 DSH JsonTree：折叠三角 + 按类型着色 + 折叠态摘要 + 复制）。 */
export const JsonView = ({ value, text, maxHeight = 420, className }: JsonViewProps) => {
  const parsed = useMemo(() => {
    if (value !== undefined) return { ok: true as const, value }
    return parseJsonText(text ?? '')
  }, [text, value])

  const formatted = useMemo(
    () => (parsed.ok ? formatJsonValue(parsed.value) : (text ?? '')),
    [parsed, text],
  )
  const tooBig =
    formatted.length > MAX_TREE_TEXT_LENGTH ||
    (parsed.ok && countJsonEntries(parsed.value, MAX_TREE_ENTRIES) >= MAX_TREE_ENTRIES)
  const [copied, setCopied] = useState(false)

  const copy = useCallback(() => {
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(formatted).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }, [formatted])

  if (!parsed.ok) {
    return (
      <div
        className={cn('overflow-hidden rounded-xl border border-border bg-sidebar', className)}
        data-json-view="error"
      >
        <div className="border-border border-b px-2 py-1">
          <p className="text-xs text-destructive">这段 JSON 解析不了：{parsed.error}</p>
        </div>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[0.75rem] leading-relaxed">
          {text}
        </pre>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-border bg-sidebar font-mono text-xs',
        className,
      )}
      data-json-view={tooBig ? 'raw' : 'tree'}
      style={{ ...TREE_STYLE, maxHeight }}
    >
      <div className="flex items-center gap-1 border-border border-b px-2 py-1 font-sans">
        <span className="text-muted-foreground text-xs lowercase">json</span>
        {tooBig ? (
          <span className="text-muted-foreground text-xs">内容过大，按原文显示</span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button aria-label="复制 JSON" onClick={copy} size="sm" variant="ghost">
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? '已复制' : '复制'}
          </Button>
        </div>
      </div>
      <div className="overflow-auto p-2" style={{ maxHeight: maxHeight - 33 }}>
        {tooBig ? (
          <pre className="whitespace-pre-wrap break-all leading-relaxed">{formatted}</pre>
        ) : (
          <JsonNode value={parsed.value} depth={0} />
        )}
      </div>
    </div>
  )
}
