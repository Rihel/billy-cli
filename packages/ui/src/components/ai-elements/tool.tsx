'use client'

import { Badge } from '#components/ui/badge.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible.tsx'
import { cn } from '#lib/utils.ts'
import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { isValidElement } from 'react'

import { JsonView } from '#components/json-view.tsx'

import { CodeBlock } from './code-block'

export type ToolProps = ComponentProps<typeof Collapsible>

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn('group not-prose mb-4 w-full rounded-md border', className)}
    {...props}
  />
)

export type ToolPart = ToolUIPart | DynamicToolUIPart

export type ToolHeaderProps = {
  title?: string
  className?: string
  /**
   * 标题与状态徽标之间的**只读元信息**（例如这次调用的耗时）。
   *
   * 为什么由调用方传而不是组件自己算：耗时是**领域数据**（服务端审计里有，历史回放时也在时间线里），
   * 组件自己只能算"挂载到结束"这段时间，刷新后就没了。
   */
  meta?: ReactNode
  /** 标题右侧的**只读细节**（如 bash 的命令），超长省略；点开卡片才看全 */
  detail?: ReactNode
} & (
  | { type: ToolUIPart['type']; state: ToolUIPart['state']; toolName?: never }
  | {
      type: DynamicToolUIPart['type']
      state: DynamicToolUIPart['state']
      toolName: string
    }
)

const statusLabels: Record<ToolPart['state'], string> = {
  'approval-requested': '等待确认',
  'approval-responded': '已回应',
  'input-available': '执行中',
  'input-streaming': '待执行',
  'output-available': '已完成',
  'output-denied': '已拒绝',
  'output-error': '出错',
}

const statusIcons: Record<ToolPart['state'], ReactNode> = {
  'approval-requested': <ClockIcon className="size-4 text-warning" />,
  'approval-responded': <CheckCircleIcon className="size-4 text-info" />,
  'input-available': <ClockIcon className="size-4 animate-pulse" />,
  'input-streaming': <CircleIcon className="size-4" />,
  'output-available': <CheckCircleIcon className="size-4 text-success" />,
  'output-denied': <XCircleIcon className="size-4 text-warning" />,
  'output-error': <XCircleIcon className="size-4 text-destructive" />,
}

/**
 * 状态徽标的底色：**语义色极淡平涂**（与 `Tag` 的语义五色同一套口径）。
 *
 * 为什么不再用 `variant="secondary"`：工具卡头部现在是 `surface-2` 的标题栏，
 * 次级底色的徽标压在同一档面色上会整个糊掉；而状态本来就是"结论"，
 * 用语义色的淡底 + 语义前景，一眼能分出完成 / 出错 / 等待确认，
 * 又不会变成强彩色块（设计系统 §8「标签」）。
 */
const statusTones: Record<ToolPart['state'], string> = {
  'approval-requested': 'bg-warning/10 text-warning',
  'approval-responded': 'bg-info/10 text-info',
  'input-available': 'bg-info/10 text-info',
  'input-streaming': 'bg-surface-3 text-muted-foreground',
  'output-available': 'bg-success/10 text-success',
  'output-denied': 'bg-warning/10 text-warning',
  'output-error': 'bg-destructive/10 text-destructive',
}

export const getStatusBadge = (status: ToolPart['state']) => (
  <Badge className={cn('gap-1.5 rounded-full text-xs', statusTones[status])} variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
)

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  meta,
  detail,
  ...props
}: ToolHeaderProps) => {
  const derivedName = type === 'dynamic-tool' ? toolName : type.split('-').slice(1).join('-')

  return (
    <CollapsibleTrigger className={cn('flex w-full items-center gap-2 p-3', className)} {...props}>
      {/* 工具条铺满整行：左边「跑了什么」，右边「跑到哪了」 */}
      <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="max-w-[40%] shrink-0 truncate font-medium text-sm">
        {title ?? derivedName}
      </span>
      {detail ? (
        // 细节紧贴标题右侧（不再 flex-1 撑满整行，否则看起来像"居中"），
        // 超过可用宽度时省略；状态徽标仍靠右
        <span className="ml-2 min-w-0 max-w-[55%] shrink truncate text-left font-mono text-xs text-muted-foreground">
          {detail}
        </span>
      ) : null}
      {meta ? (
        <span className="ml-2 shrink-0 text-xs text-muted-foreground tabular-nums">{meta}</span>
      ) : null}
      <span className="ml-auto shrink-0">{getStatusBadge(state)}</span>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  )
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      /**
       * 展开后**限高 + 内部滚动**：工具出参可能是几 MB 的命令输出 / 日志，
       * 不限高的话一张卡就能把整条时间线撑成"没有底"，用户再想往上翻要滚半天。
       * 高度跟视口走（短屏自动更矮），超过就在卡片里滚，时间线本身仍是一条线。
       */
      'max-h-[min(60vh,28rem)] overflow-y-auto',
      className,
    )}
    {...props}
  />
)

export type ToolInputProps = ComponentProps<'div'> & {
  input: ToolPart['input']
}

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn('space-y-2 overflow-hidden', className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs tracking-wide">入参</h4>
    {/*
      入参**可能还没到**：AI SDK 收到 `tool-input-start` 时会把 part 置成 `input-streaming`，
      此时 `input` 是 `undefined`，要等第一个 delta 才有半成品。默认展开的计划卡会在这一刻
      直接渲染到这里 —— `JSON.stringify(undefined)` 返回的也是 `undefined`（不是字符串），
      再交给代码块就会在 `code.split` 处抛错、把整棵会话树打崩。缺入参时给一句状态说明。
    */}
    {input === undefined ? (
      <div className="rounded-md bg-muted/50">
        <p className="px-4 py-3 text-muted-foreground text-xs">（暂无入参）</p>
      </div>
    ) : (
      // 入参是结构化的，用 JSON 查看器而不是高亮代码块：一层一行、可折叠，长嵌套不用横向滚
      //（`JsonView` 自带 200KB / 2000 条上限，超大入参退回原文；它自己也带边框与底色，不再套一层容器）
      <JsonView maxHeight={288} value={input} className="rounded-none border-0 bg-transparent" />
    )}
  </div>
)

export type ToolOutputProps = ComponentProps<'div'> & {
  output: ToolPart['output']
  errorText: ToolPart['errorText']
}

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null
  }

  let Output = <div>{output as ReactNode}</div>

  if (typeof output === 'object' && !isValidElement(output)) {
    // 出参同理；字符串出参可能是任意文本（日志、命令输出），仍按代码块显示
    Output = (
      <JsonView maxHeight={288} value={output} className="rounded-none border-0 bg-transparent" />
    )
  } else if (typeof output === 'string') {
    Output = <CodeBlock code={output} language="json" />
  }

  return (
    <div className={cn('space-y-2', className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs tracking-wide">
        {errorText ? '错误' : '结果'}
      </h4>
      <div
        className={cn(
          'overflow-x-auto text-xs [&_table]:w-full',
          // 对象的出参由 JsonView 自己渲染（已去掉它的卡片外观）；
          // 字符串出参走 CodeBlock、本身带底，这里不再套一层底色
          errorText && 'rounded-md bg-destructive/10 p-2 text-destructive',
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  )
}
