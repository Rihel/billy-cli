'use client'

import { cn } from '#lib/utils.ts'
import { Loader2Icon, TriangleAlertIcon } from 'lucide-react'

/**
 * 围栏共用的三块外壳：生成中占位、错误卡、源码折叠。
 *
 * 三件事都不该每个围栏各写一遍，但也不值得抽成全局组件 —— 它们只服务这一组围栏。
 */

export interface FencePendingProps {
  language: string
  className?: string
}

/**
 * 围栏还没闭合时的占位。
 *
 * `html` / `gsap` / `xflow` 在流式过程中**不渲染**：每来一个 token 就重建 iframe 等于把脚本反复重跑，
 * 每来一个 token 就重排流程图会让节点来回跳。闭合一次、渲染一次，用户看到的是"生成完了直接出现"。
 */
export const FencePending = ({ language, className }: FencePendingProps) => (
  <div
    className={cn(
      'my-4 flex items-center gap-2 rounded-xl border border-border border-dashed bg-sidebar px-3 py-4 text-muted-foreground text-xs',
      className,
    )}
    data-fence-pending={language}
  >
    <Loader2Icon className="animate-spin" size={12} />
    <span className="font-mono lowercase">{language}</span>
    <span>正在生成，围栏闭合后渲染</span>
  </div>
)

export interface FenceErrorProps {
  language: string
  message: string
  className?: string
}

/** 渲染失败：把原因说清楚，并把原文交给调用方一起展示（不静默丢内容） */
export const FenceError = ({ language, message, className }: FenceErrorProps) => (
  <div
    className={cn('my-4 rounded-xl border border-border bg-sidebar p-3', className)}
    data-fence-error={language}
  >
    <p className="flex items-center gap-2 text-sm text-destructive">
      <TriangleAlertIcon size={14} />
      这段 {language} 渲染不了：{message}
    </p>
  </div>
)

export interface FenceSourceProps {
  code: string
  label?: string
}

/** 折叠的源码：围栏渲染成功时也留一条"看它到底写了什么"的路 */
export const FenceSource = ({ code, label = '源码' }: FenceSourceProps) => (
  <details className="mt-2">
    <summary className="cursor-pointer select-none text-muted-foreground text-xs hover:text-foreground">
      {label}
    </summary>
    <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-muted p-3 font-mono text-[0.75rem] leading-relaxed">
      {code}
    </pre>
  </details>
)
