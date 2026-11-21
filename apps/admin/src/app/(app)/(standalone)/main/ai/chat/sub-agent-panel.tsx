'use client'

import type { UIMessage } from 'ai'
import { Badge } from '@repo/ui'
import { BotIcon, LoaderCircleIcon } from 'lucide-react'
import { isSubAgentActive, livePartsOf, type SubAgentLive } from './sub-agent-live'
import { statusLabel, statusVariant } from './sub-agent-status'
import { ChatMessage } from './message-row'
import { toMessageState } from './chat-session'

/**
 * 子助手的**过程视图**（主区顶部子 agent tab 在"运行中"时显示的内容）。
 *
 * 数据来自实时流（`sub-agent-live.ts` 收集的 `data-sub-agent*` 块）——
 * 会话页在**同一次渲染**里把最后一条消息的 parts 收好传进来，所以运行中也能逐帧看到推理与正文；
 * 跑完之后改用库里那份完整时间线（见 `session-tabs.tsx` 的 `SubRunView`）。
 *
 * **渲染只有一条路**：实时事件先映射成与历史时间线同形的 UI parts（`livePartsOf`），
 * 再交给主对话同一个 `ChatMessage`（工具卡 / 推理卡 / 正文都只有那一份实现）。
 * 2026-11-21 之前这里手写过一套工具卡与灰底正文，结果是"同一段过程，跑到一半和跑完
 * 长得不一样"（用户反馈）；现在不再自己画。
 */

const formatDuration = (ms?: number): string =>
  ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`

export function SubAgentLiveView({ live }: { live: SubAgentLive }) {
  const active = isSubAgentActive(live)
  const parts = livePartsOf(live, { streaming: active })
  const hasAnything =
    Boolean(live.task) ||
    Boolean(live.reasoning) ||
    Boolean(live.text) ||
    Boolean(live.result) ||
    live.events.length > 0 ||
    (live.entries?.length ?? 0) > 0

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {active ? (
          <LoaderCircleIcon
            className="size-3.5 animate-spin text-primary motion-reduce:animate-none"
            aria-hidden
          />
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

      {hasAnything ? (
        // 与主对话、与跑完后的 SubRunView **同一个渲染器**：工具卡 / 推理 / 正文都只有一份实现
        <ChatMessage
          message={toMessageState({
            id: live.runId,
            role: 'assistant',
            parts,
          } as UIMessage)}
          streaming={active}
          showTrailingCards={false}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          {active
            ? '子助手正在准备…（推理与工具往返会在这里逐帧出现）'
            : '这个子助手没有留下可显示的过程记录。'}
        </p>
      )}

      {live.error ? <p className="text-xs text-destructive">{live.error}</p> : null}
    </div>
  )
}
