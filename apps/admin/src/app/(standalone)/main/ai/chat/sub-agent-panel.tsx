'use client'

import { Badge } from '@repo/ui'
// ai-elements 组件**走子路径**（不进 barrel：体积大、按需引入，见 docs/design/ai-agent.md §1）
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@repo/ui/components/ai-elements/reasoning.tsx'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@repo/ui/components/ai-elements/tool.tsx'
import { BotIcon, LoaderCircleIcon } from 'lucide-react'
import { isSubAgentActive, type SubAgentLive } from './sub-agent-live'

/**
 * 子助手的**过程视图**（右栏「子 agent」tab 的内容）。
 *
 * 数据来自实时流（`sub-agent-live.ts` 收集的 `data-sub-agent*` 块）——
 * 会话页在**同一次渲染**里把最后一条消息的 parts 收好传进来，所以运行中也能逐帧看到推理与正文；
 * 跑完之后右栏改用库里那份完整时间线（见 `right-panel.tsx` 的 `SubRunView`），
 * 这份视图只在"还在跑 / 库里暂时没有该 run"时出场。
 *
 * 正文用 `whitespace-pre-wrap` 而不是 Markdown 渲染：这一段是**每个增量 tick 都在变**的长文本，
 * 边跑边做一遍 Markdown 解析纯属浪费；跑到终点后由 `SubRunView` 用主对话同一个 `ChatMessage`
 * 渲染成正式的样子。
 */

/** 运行状态 → 人话（右栏的「子 agent 运行」也用这一份，口径不分叉） */
export const statusLabel: Record<string, string> = {
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已停止',
  rejected: '未执行',
}

export const statusVariant = (status?: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
  if (status === 'succeeded') return 'default'
  if (status === 'failed') return 'destructive'
  if (status === 'running') return 'secondary'
  return 'outline'
}

const formatDuration = (ms?: number): string =>
  ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`

export function SubAgentLiveView({ live }: { live: SubAgentLive }) {
  const active = isSubAgentActive(live)
  // 正文 / 推理在写入时已经聚合成字符串（见 `sub-agent-live.ts` 的文件头）：
  // 这里不再每帧 filter+map+join 数万条增量
  const streamedText = live.text
  const streamedReasoning = live.reasoning
  const text = streamedText || live.result || ''
  const hasAnything =
    Boolean(live.task) || Boolean(streamedReasoning) || Boolean(text) || live.events.length > 0

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {active ? (
          <LoaderCircleIcon className="size-3.5 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
        ) : (
          <BotIcon className="size-3.5" aria-hidden />
        )}
        <span className="font-medium text-foreground">{live.name}</span>
        <Badge variant={statusVariant(live.status ?? 'running')}>
          {statusLabel[live.status ?? 'running'] ?? '进行中'}
        </Badge>
        {typeof live.stepCount === 'number' || typeof live.toolCallCount === 'number' ? (
          <span>
            {live.stepCount ?? 0} 步 / {live.toolCallCount ?? 0} 次工具
            {live.durationMs !== undefined ? ` · ${formatDuration(live.durationMs)}` : ''}
          </span>
        ) : null}
      </div>

      {live.task ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">任务：</span>
          {live.task}
        </p>
      ) : null}
      {live.reason ? <p className="text-xs text-warning">{live.reason}</p> : null}

      {streamedReasoning ? (
        <Reasoning isStreaming={active}>
          <ReasoningTrigger
            getThinkingMessage={(streaming) => (
              <span>{streaming ? '子助手思考中…' : '子助手思考过程'}</span>
            )}
          />
          <ReasoningContent>{streamedReasoning}</ReasoningContent>
        </Reasoning>
      ) : null}

      {text ? (
        <div className="rounded-md bg-muted/40 p-2 text-sm whitespace-pre-wrap">{text}</div>
      ) : null}

      {/* 工具往返：实时状态下服务端按 id 归并状态块，所以这里通常只有**最近一次**
          （完整序列在跑完之后从库里的子 run 时间线看，见 sub-agent-live.ts 的文件头说明） */}
      {live.events.map((event, index) => (
        <Tool key={`${event.toolCallId ?? index}-${event.kind}`} defaultOpen={false}>
          <ToolHeader
            type="dynamic-tool"
            state={event.isError ? 'output-error' : 'output-available'}
            toolName={event.toolKey ?? 'tool'}
          />
          <ToolContent>
            {event.kind === 'tool-call' ? (
              <ToolInput input={event.input} />
            ) : (
              <ToolOutput
                output={event.output}
                errorText={event.isError ? (event.errorText ?? JSON.stringify(event.output ?? '')) : undefined}
              />
            )}
          </ToolContent>
        </Tool>
      ))}

      {live.error ? <p className="text-xs text-destructive">{live.error}</p> : null}

      {!hasAnything ? (
        <p className="text-xs text-muted-foreground">
          {active ? '子助手正在准备…（推理与工具往返会在这里逐帧出现）' : '这个子助手没有留下可显示的过程记录。'}
        </p>
      ) : null}
    </div>
  )
}
