"use client"

import { Badge } from "#components/ui/badge.tsx"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "#components/ui/collapsible.tsx"
import { cn } from "#lib/utils.ts"
import type { DynamicToolUIPart, ToolUIPart } from "ai"
import { CheckCircleIcon, ChevronDownIcon, CircleIcon, ClockIcon, WrenchIcon, XCircleIcon } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import { isValidElement } from "react"

import { CodeBlock } from "./code-block"

export type ToolProps = ComponentProps<typeof Collapsible>

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn("group not-prose mb-4 w-full rounded-md border", className)} {...props} />
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
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"]
      state: DynamicToolUIPart["state"]
      toolName: string
    }
)

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "等待确认",
  "approval-responded": "已回应",
  "input-available": "执行中",
  "input-streaming": "待执行",
  "output-available": "已完成",
  "output-denied": "已拒绝",
  "output-error": "出错",
}

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-warning" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-info" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-success" />,
  "output-denied": <XCircleIcon className="size-4 text-warning" />,
  "output-error": <XCircleIcon className="size-4 text-destructive" />,
}

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
)

export const ToolHeader = ({ className, title, type, state, toolName, meta, ...props }: ToolHeaderProps) => {
  const derivedName = type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-")

  return (
    <CollapsibleTrigger className={cn("flex w-full items-center gap-2 p-3", className)} {...props}>
      {/* 工具条铺满整行：左边「跑了什么」，右边「跑到哪了」 */}
      <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium text-sm">{title ?? derivedName}</span>
      {meta ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{meta}</span> : null}
      <span className="ml-auto shrink-0">{getStatusBadge(state)}</span>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  )
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
)

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"]
}

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs tracking-wide">入参</h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
)

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"]
  errorText: ToolPart["errorText"]
}

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null
  }

  let Output = <div>{output as ReactNode}</div>

  if (typeof output === "object" && !isValidElement(output)) {
    Output = <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs tracking-wide">{errorText ? "错误" : "结果"}</h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground",
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  )
}
