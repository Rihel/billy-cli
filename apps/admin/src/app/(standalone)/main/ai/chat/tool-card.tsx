'use client'

import { useEffect, useRef, useState } from 'react'
import { getToolName } from 'ai'
// ai-elements 组件**走子路径且带扩展名**（不进 barrel：体积大、按需引入，见 docs/design/ai-agent.md §1）
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@repo/ui/components/ai-elements/tool.tsx'
import type { ToolPart } from '@repo/ui/components/ai-elements/tool.tsx'
import type { ToolEventPart } from '@repo/shared'
import { durationText } from './format'
import { ToolEventsBody } from './tool-event'

/**
 * 工具卡：一次工具调用画成一张卡 —— 头部七态徽标 + 入参出参 + 自定义事件。
 *
 * **为什么受控**（而不是用 `Tool` 的 `defaultOpen`）：自定义事件是**过程**，越早看见越好，
 * 但事件必然晚于工具卡本身到达 —— 非受控的 `defaultOpen` 只在挂载那一刻生效，
 * 卡片挂载之后事件再流进来也不会展开，这个能力就白做了。
 *
 * 两条自我约束：
 * - **用户手动优先**：用户一旦自己开合过，就彻底不再自动展开（别跟用户的手打架）；
 * - **只在流式期间自动展开**：`streaming` 是会话级的"这一轮还在跑"，历史 / 重放不该抢用户的视图。
 *
 * 刻意**不做**"必须亲眼看见事件数 0 → 正"的过渡判定：工具卡与它首批事件可能落在同一批
 * state 更新里（React 批处理），卡片一挂载就带着事件 —— 那种情况同样要展开。
 */

/** 自动展开的判据（纯函数，可单测）：**有事件**、且**用户没自己动过手** */
export const shouldAutoOpen = (hasEvents: boolean, userToggled: boolean): boolean =>
  hasEvents && !userToggled

/**
 * 从工具入参里取"为什么调它"（模型每次调用都必须写，由服务端引擎强制，见设计 §5.18）。
 *
 * 入参可能还没有（调用进行中）/ 结构异常（模型乱写）/ 字段缺失 —— 一律返回 null 让调用方不渲染，
 * 前端**不因为展示位而抛错**（工具卡是过程视图，缺一行比白屏好）。
 */
export const toolCallReason = (input: unknown): string | null => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const value = (input as Record<string, unknown>).reason
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export interface ToolCardProps {
  /** 工具 part（AI SDK 的 `dynamic-tool` 形态，调用中 / 有出参 / 出错都在里面） */
  part: ToolPart
  /** 这次工具调用发的事件（没有事件时传空数组） */
  events: ToolEventPart[]
  /** 初始是否展开（计划类工具按既有口径默认展开） */
  defaultOpen: boolean
  /** 所属这一轮是否还在流式输出 */
  streaming: boolean
  /**
   * 这次调用的耗时（毫秒）—— **历史回放**时由时间线提供（服务端审计量的真实值）。
   * 实时那条流里没有这个字段，留空由本组件自己计时（挂载 → 结束）。
   */
  durationMs?: number
}

export function ToolCard({ part, events, defaultOpen, streaming, durationMs }: ToolCardProps) {
  const [open, setOpen] = useState(defaultOpen)
  /** 用户是否自己动过手：动过之后就不再自动展开 */
  const [userToggled, setUserToggled] = useState(false)
  const eventCount = events.length

  /**
   * **实时耗时**（用户要求"工具条显示耗时"）：从卡片出现（= 这次调用开始流给我们）到拿到结果。
   *
   * 为什么运行中要每 0.5s 刷一次：工具卡是"正在调什么、跑了多久"的唯一落点，数字停着不动
   * 会让人以为卡死。有历史耗时（`durationMs`，服务端审计量的）时**不自己算** —— 那才是真值。
   */
  const isFinished = part.state === 'output-available' || part.state === 'output-error'
  const startedAtRef = useRef<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)

  useEffect(() => {
    if (durationMs !== undefined) return
    if (isFinished) {
      if (startedAtRef.current !== null) {
        setElapsedMs(Date.now() - startedAtRef.current)
        startedAtRef.current = null
      }
      return
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now()
    const timer = setInterval(() => {
      if (startedAtRef.current !== null) setElapsedMs(Date.now() - startedAtRef.current)
    }, 500)
    return () => clearInterval(timer)
  }, [durationMs, isFinished])

  const shownMs = durationMs ?? elapsedMs

  useEffect(() => {
    if (!streaming) return
    if (!shouldAutoOpen(eventCount > 0, userToggled)) return
    setOpen(true)
  }, [streaming, eventCount, userToggled])

  const toolName = getToolName(part)
  const reason = toolCallReason(part.input)

  return (
    <Tool
      className="mb-2"
      open={open}
      onOpenChange={(next) => {
        // 记下"用户动过手"：从此以后自动展开让位，只认用户的选择
        setUserToggled(true)
        setOpen(next)
      }}
    >
      <ToolHeader
        type="dynamic-tool"
        state={part.state}
        toolName={toolName}
        className="px-2.5 py-1.5"
        meta={shownMs !== null && shownMs !== undefined ? durationText(shownMs) : undefined}
      />
      <ToolContent className="space-y-2 p-2.5">
        {/*
          "为什么"放在**卡片头部之下、入参之上**：它是这次调用的动机（模型自述的目的），
          比入参更该先被扫到；折进「入参」的 JSON 里就等于没做这个特性。
          放在 `ToolContent` 内是为了跟着展开态走（与入参出参同一层），只读一行、不参与交互。
        */}
        {reason && (
          <p className="border-border border-l-2 pl-2 text-xs text-muted-foreground">
            <span className="font-medium">为什么：</span>
            {reason}
          </p>
        )}
        <ToolInput input={part.input} className="space-y-1" />
        {part.state === 'output-available' && (
          <ToolOutput output={part.output} errorText={undefined} className="space-y-1" />
        )}
        {part.state === 'output-error' && (
          <ToolOutput output={undefined} errorText={part.errorText} className="space-y-1" />
        )}
        <ToolEventsBody toolKey={toolName} parts={events} />
      </ToolContent>
    </Tool>
  )
}
