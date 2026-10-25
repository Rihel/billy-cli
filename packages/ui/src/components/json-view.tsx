"use client"

import { Button } from "#components/ui/button.tsx"
import { cn } from "#lib/utils.ts"
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react"
import { memo, useCallback, useMemo, useState } from "react"

/**
 * JSON 查看器：把一段 JSON 渲染成可折叠的树，而不是一大块高亮代码。
 *
 * 为什么单独做一个：会话里的 ```json 围栏、后台的告警快照 / 工具入参出参，本质都是
 * "结构化的数据"，用代码块渲染时读者只能盯着括号数层次，长嵌套还要横向滚。这里做成
 * **一层一行、可折叠、容器给条数摘要**，扫一眼就知道结构。
 *
 * 两条刻意的克制：
 * - **不上彩虹配色**：键用次要色、值用正文色，类型靠字面量自己表达（引号 / true / null），
 *   符合后台「微色阶表达层次」的规矩；
 * - **有上限**：太长的文本、太多条目的对象直接退回原始文本并说明原因 —— 一个 5MB 的
 *   JSON 展开成树会把标签页卡死，这不是"渲染得更好"，是闯祸。
 */

/** 超过这个长度的原文不做树形渲染（解析本身没问题，是 DOM 撑不住） */
const MAX_TREE_TEXT_LENGTH = 200_000
/** 超过这个条目数不做树形渲染 */
const MAX_TREE_ENTRIES = 2_000
/** 单行字符串的默认截断长度，点一下可以展开 */
const STRING_PREVIEW_LENGTH = 120

export type JsonValueKind = "string" | "number" | "boolean" | "null" | "array" | "object"

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

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
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  switch (typeof value) {
    case "string":
      return "string"
    case "number":
      return "number"
    case "boolean":
      return "boolean"
    case "object":
      return "object"
    default:
      // undefined / function / symbol 不是合法 JSON，兜底按 null 处理
      return "null"
  }
}

/** 是不是容器（对象或数组）：只有容器才有折叠 */
export const isJsonContainer = (value: unknown): value is Record<string, unknown> | unknown[] => {
  const kind = jsonValueKind(value)
  return kind === "object" || kind === "array"
}

/** 容器/字符串的一行摘要，例如 `{4 个字段}`、`[3 项]`、`"https://…"` */
export const summarizeJsonValue = (value: unknown, limit = STRING_PREVIEW_LENGTH): string => {
  const kind = jsonValueKind(value)
  if (kind === "array") return `[${(value as unknown[]).length} 项]`
  if (kind === "object") return `{${Object.keys(value as Record<string, unknown>).length} 个字段}`
  if (kind === "string") {
    const text = value as string
    const single = text.replace(/\s+/g, " ").trim()
    return single.length > limit ? `${single.slice(0, limit)}…` : single
  }
  if (kind === "null") return "null"
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

const PrimitiveText = ({ value }: { value: unknown }) => {
  const kind = jsonValueKind(value)
  const [expanded, setExpanded] = useState(false)

  if (kind === "string") {
    const text = value as string
    const tooLong = text.length > STRING_PREVIEW_LENGTH
    const shown = tooLong && !expanded ? `${text.slice(0, STRING_PREVIEW_LENGTH)}…` : text
    return (
      <span className="break-all">
        <span className="text-foreground">&quot;{shown}&quot;</span>
        {tooLong ? (
          <button
            className="ml-1 text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
            onClick={() => setExpanded((previous) => !previous)}
            type="button"
          >
            {expanded ? "收起" : `展开（${text.length} 字）`}
          </button>
        ) : null}
      </span>
    )
  }

  if (kind === "null") return <span className="text-muted-foreground italic">null</span>
  if (kind === "number") return <span className="tabular-nums text-foreground">{String(value)}</span>
  if (kind === "boolean") return <span className="font-medium text-foreground">{String(value)}</span>
  return <span className="text-foreground">{String(value)}</span>
}

interface NodeProps {
  /** 键名或数组下标；根节点没有名字 */
  name: string | null
  value: unknown
  depth: number
  /** 初始展开到第几层 */
  defaultExpandDepth: number
}

const JsonNode = memo(function JsonNode({ name, value, depth, defaultExpandDepth }: NodeProps) {
  const container = isJsonContainer(value)
  const [open, setOpen] = useState(depth < defaultExpandDepth)
  const children = useMemo(() => {
    if (!container) return []
    if (Array.isArray(value)) return value.map((item, index) => [`[${index}]`, item] as const)
    return Object.entries(value as Record<string, unknown>)
  }, [container, value])

  return (
    <div>
      <div
        className="group flex items-start gap-1 rounded px-1 py-0.5 hover:bg-muted/60"
        style={{ paddingLeft: depth * 14 }}
      >
        {container ? (
          <button
            aria-expanded={open}
            aria-label={open ? "收起" : "展开"}
            className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((previous) => !previous)}
            type="button"
          >
            <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} size={12} />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {name === null ? null : (
          <span className="shrink-0 text-muted-foreground">{name}:</span>
        )}

        {container ? (
          <button
            className="truncate text-left text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((previous) => !previous)}
            type="button"
          >
            {summarizeJsonValue(value)}
            {open ? null : " …"}
          </button>
        ) : (
          <PrimitiveText value={value} />
        )}
      </div>

      {container && open
        ? children.map(([childName, childValue]) => (
            <JsonNode
              defaultExpandDepth={defaultExpandDepth}
              depth={depth + 1}
              key={`${depth}-${childName}`}
              name={childName}
              value={childValue}
            />
          ))
        : null}
    </div>
  )
})

export interface JsonViewProps {
  /** 已经解析好的值（与 `text` 二选一，同时给时以 `value` 为准） */
  value?: unknown
  /** 原始 JSON 文本：解析失败时按原文展示并说明原因 */
  text?: string
  /** 初始展开层数，默认 2 */
  defaultExpandDepth?: number
  /** 树的最大高度（px），超出滚动，默认 420 */
  maxHeight?: number
  className?: string
}

/**
 * JSON 查看器：树 / 原文两种视图 + 复制。
 *
 * 解析失败不吞内容：报错原因 + 原文照常显示，读者能自己判断是"模型写错了"还是"这不是 JSON"。
 */
export const JsonView = ({
  value,
  text,
  defaultExpandDepth = 2,
  maxHeight = 420,
  className,
}: JsonViewProps) => {
  const parsed = useMemo(() => {
    if (value !== undefined) return { ok: true as const, value }
    return parseJsonText(text ?? "")
  }, [text, value])

  const [view, setView] = useState<"tree" | "raw">("tree")
  /**
   * 展开/收起全部靠整棵树重挂载，避免每个节点各记一份状态：
   * `default` 用传入的层数、`all` 铺到底、`none` 只留根节点一行。
   */
  const [treeMode, setTreeMode] = useState<"default" | "all" | "none">("default")
  const [treeKey, setTreeKey] = useState(0)
  const [copied, setCopied] = useState(false)

  const formatted = useMemo(
    () => (parsed.ok ? formatJsonValue(parsed.value) : (text ?? "")),
    [parsed, text],
  )

  const copy = useCallback(() => {
    // 非安全上下文（http 内网页）里没有 clipboard，静默降级，不抛错
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(formatted).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }, [formatted])

  if (!parsed.ok) {
    return (
      <div className={cn("rounded-xl border border-border bg-sidebar p-3", className)} data-json-view="error">
        <p className="text-sm text-destructive">这段 JSON 解析不了：{parsed.error}</p>
        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-[0.75rem] leading-relaxed">
          {text}
        </pre>
      </div>
    )
  }

  const tooBig =
    formatted.length > MAX_TREE_TEXT_LENGTH ||
    // 计数到上限就停，所以这里用 `>=`：正好等于上限也按"过大"处理
    countJsonEntries(parsed.value, MAX_TREE_ENTRIES) >= MAX_TREE_ENTRIES
  const showTree = view === "tree" && !tooBig

  return (
    <div
      className={cn("overflow-hidden rounded-xl border border-border bg-sidebar", className)}
      data-json-view={showTree ? "tree" : "raw"}
    >
      <div className="flex flex-wrap items-center gap-1 border-border border-b px-2 py-1">
        <span className="font-mono text-muted-foreground text-xs lowercase">json</span>
        <div className="ml-auto flex items-center gap-1">
          {showTree ? (
            <>
              <Button
                onClick={() => {
                  setTreeMode("all")
                  setTreeKey((key) => key + 1)
                }}
                size="sm"
                variant="ghost"
              >
                展开全部
              </Button>
              <Button
                onClick={() => {
                  setTreeMode("none")
                  setTreeKey((key) => key + 1)
                }}
                size="sm"
                variant="ghost"
              >
                收起全部
              </Button>
            </>
          ) : null}
          {tooBig ? (
            <span className="px-1 text-muted-foreground text-xs">内容过大，按原文显示</span>
          ) : (
            <Button onClick={() => setView(showTree ? "raw" : "tree")} size="sm" variant="ghost">
              {showTree ? "原文" : "树形"}
            </Button>
          )}
          <Button aria-label="复制 JSON" onClick={copy} size="sm" variant="ghost">
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "已复制" : "复制"}
          </Button>
        </div>
      </div>

      {showTree ? (
        <div className="overflow-auto p-2 font-mono text-[0.75rem] leading-relaxed" style={{ maxHeight }} key={treeKey}>
          <JsonNode
            defaultExpandDepth={
              treeMode === "all"
                ? Number.POSITIVE_INFINITY
                : treeMode === "none"
                  ? 0
                  : defaultExpandDepth
            }
            depth={0}
            name={null}
            value={parsed.value}
          />
        </div>
      ) : (
        <pre
          className="overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[0.75rem] leading-relaxed"
          style={{ maxHeight }}
        >
          {formatted}
        </pre>
      )}
    </div>
  )
}
