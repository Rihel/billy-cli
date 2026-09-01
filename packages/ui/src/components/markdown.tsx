"use client"

import * as React from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import remarkGfm from "remark-gfm"

import { cn } from "#lib/utils"

export type MarkdownProps = {
  /** Markdown 源文本 */
  content: string
  /** 容器 className */
  className?: string
  /** 覆盖默认元素渲染（按元素名与内置样式合并，传入同名元素即整体替换） */
  components?: Components
}

/**
 * 每个 markdown 元素的渲染样式（Tailwind + shadcn 主题 token，统一 radius 体系：
 * 代码块 / 引用 / 图片用 rounded-lg，行内代码用 rounded-md）。
 */
const markdownComponents: Components = {
  h1: ({ node, children }) => (
    <h1 className="mb-4 mt-8 scroll-m-20 border-b border-border pb-2 text-2xl font-semibold tracking-tight">
      {children}
    </h1>
  ),
  h2: ({ node, children }) => (
    <h2 className="mb-3 mt-8 scroll-m-20 border-b border-border pb-2 text-xl font-semibold tracking-tight">
      {children}
    </h2>
  ),
  h3: ({ node, children }) => (
    <h3 className="mb-2 mt-6 scroll-m-20 text-lg font-semibold tracking-tight">{children}</h3>
  ),
  h4: ({ node, children }) => (
    <h4 className="mb-2 mt-6 scroll-m-20 text-base font-semibold tracking-tight">{children}</h4>
  ),
  h5: ({ node, children }) => (
    <h5 className="mb-2 mt-6 scroll-m-20 text-sm font-semibold tracking-tight">{children}</h5>
  ),
  h6: ({ node, children }) => (
    <h6 className="mb-2 mt-6 scroll-m-20 text-sm font-semibold tracking-tight">{children}</h6>
  ),
  p: ({ node, children }) => <p className="my-4 leading-relaxed">{children}</p>,
  a: ({ node, href, children }) => (
    <a
      href={href}
      className="font-medium text-primary underline underline-offset-4 hover:opacity-80"
    >
      {children}
    </a>
  ),
  strong: ({ node, children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ node, children }) => <em className="italic">{children}</em>,
  del: ({ node, children }) => <del className="line-through">{children}</del>,
  hr: () => <hr className="my-8 border-border" />,
  ul: ({ node, className, children, ...props }) => (
    <ul
      className={cn(
        "my-4 list-disc pl-6",
        className?.includes("contains-task-list") && "list-none pl-1",
        className,
      )}
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ node, className, children, ...props }) => (
    <ol className={cn("my-4 list-decimal pl-6", className)} {...props}>
      {children}
    </ol>
  ),
  li: ({ node, className, children, ...props }) => (
    <li
      className={cn(
        "my-1.5 leading-relaxed",
        className?.includes("task-list-item") && "flex items-start gap-2",
        className,
      )}
      {...props}
    >
      {children}
    </li>
  ),
  blockquote: ({ node, children }) => (
    <blockquote className="my-4 rounded-r-md border-l-4 border-border bg-muted/40 py-1 pl-4 pr-4 text-muted-foreground">
      {children}
    </blockquote>
  ),
  code: ({ node, className, children, ...props }) => {
    // 代码块（rehype-highlight 会附加 hljs / language-* 类），否则为行内代码
    const isBlock = /language-|hljs/.test(className ?? "")
    if (isBlock) {
      return (
        <code
          className={cn(
            "block bg-transparent p-0 font-mono text-[0.8125rem] leading-relaxed",
            className,
          )}
          {...props}
        >
          {children}
        </code>
      )
    }
    return (
      <code
        className={cn(
          "rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.875em]",
          className,
        )}
        {...props}
      >
        {children}
      </code>
    )
  },
  pre: ({ node, children }) => (
    <pre className="my-4 overflow-x-auto rounded-lg border border-border bg-muted p-4 text-[0.8125rem] leading-relaxed">
      {children}
    </pre>
  ),
  table: ({ node, children }) => (
    <div className="my-4 w-full overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ node, className, children, ...props }) => (
    <thead className={cn("bg-muted", className)} {...props}>
      {children}
    </thead>
  ),
  tbody: ({ node, children }) => <tbody>{children}</tbody>,
  tr: ({ node, className, children, ...props }) => (
    <tr className={cn("even:bg-muted/40", className)} {...props}>
      {children}
    </tr>
  ),
  th: ({ node, className, children, ...props }) => (
    <th
      className={cn("border border-border px-3 py-2 text-left font-semibold", className)}
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ node, className, children, ...props }) => (
    <td className={cn("border border-border px-3 py-2 align-top", className)} {...props}>
      {children}
    </td>
  ),
  input: ({ node, className, ...props }) => (
    <input className={cn("mt-1 size-4 shrink-0 accent-primary", className)} {...props} />
  ),
  img: ({ node, src, alt }) => (
    <img src={src} alt={alt} className="my-4 max-w-full rounded-lg" />
  ),
}

/**
 * Markdown 文档渲染组件。
 *
 * - 基于 react-markdown，默认支持 GFM（表格 / 任务列表 / 删除线 / 自动链接）；
 * - 每个元素都有内置渲染样式（见 markdownComponents），支持按元素覆盖；
 * - 代码块经 rehype-highlight（highlight.js）语法高亮，token 色在 globals.css
 *   的 `--md-hl-*` 变量，随明暗模式切换；
 * - 出于安全默认不渲染原始 HTML（react-markdown 默认剥离），如确需渲染请自行
 *   接入 rehype-raw 并做好消毒。
 */
export function Markdown({ content, className, components }: MarkdownProps) {
  return (
    <div className={cn("markdown min-w-0 text-sm", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{ ...markdownComponents, ...components }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
