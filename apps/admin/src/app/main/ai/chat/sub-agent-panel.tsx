'use client'

import { useState } from 'react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
} from '@repo/ui'
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
import { ChevronDownIcon, BotIcon } from 'lucide-react'
import { tokenText } from './format'

/** 子助手面板的状态（来自 `data-sub-agent` 块：带 id、按 id 归并，读到的永远是当前态） */
export interface SubAgentState {
  runId: string
  name: string
  status?: string
  result?: string
  error?: string | null
  stepCount?: number
  toolCallCount?: number
  usage?: Record<string, unknown> | null
  durationMs?: number
  reason?: string
  /** 历史模式：父的时间线里只有结论，想看它的推理与工具往返要按需拉子 run 的时间线 */
  loadDetail?: () => Promise<{
    reasoning: string
    text: string
    events: Array<{
      kind: 'tool-call' | 'tool-result'
      toolKey: string | null
      input?: unknown
      output?: unknown
      isError?: boolean
    }>
  }>
}

/** 增量（`data-sub-agent-delta` 块：不带 id，按到达顺序累计） */
export interface SubAgentDelta {
  kind: 'text' | 'reasoning'
  text: string
}

const statusLabel: Record<string, string> = {
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已停止',
  rejected: '未执行',
}

const statusVariant = (status?: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
  if (status === 'succeeded') return 'default'
  if (status === 'failed') return 'destructive'
  if (status === 'running') return 'secondary'
  return 'outline'
}

const formatDuration = (ms?: number): string =>
  ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`

/**
 * 子助手面板：**一个子 agent 一张卡片**。
 *
 * 数据来源有两条，最终合成同一种结构：
 * - 实时：`data-sub-agent`（状态，按 id 归并）+ `data-sub-agent-delta`（流式增量）；
 * - 历史：父时间线里的工具结论（`data-sub-agent` part 由 `history.ts` 合成），
 *   想看它的推理与工具往返就按需拉子 run 的时间线（`loadDetail`）。
 *
 * 子 agent 的明细全部入库（独立 run + 完整时间线，设计文档 §3.14.3），
 * 所以这里展示的每一段都能在库里查到原始记录。
 */
export function SubAgentPanel({
  agent,
  deltas,
}: {
  agent: SubAgentState
  deltas: SubAgentDelta[]
}) {
  const [open, setOpen] = useState(agent.status === 'running')
  const [detail, setDetail] = useState<Awaited<ReturnType<NonNullable<SubAgentState['loadDetail']>>>>()
  const [loading, setLoading] = useState(false)

  const streamedText = deltas
    .filter((delta) => delta.kind === 'text')
    .map((delta) => delta.text)
    .join('')
  const streamedReasoning = deltas
    .filter((delta) => delta.kind === 'reasoning')
    .map((delta) => delta.text)
    .join('')
  const reasoning = detail?.reasoning || streamedReasoning
  const text = detail?.text || streamedText || agent.result || ''

  const loadDetail = async () => {
    if (!agent.loadDetail || detail || loading) return
    setLoading(true)
    try {
      setDetail(await agent.loadDetail())
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="gap-0 border-dashed py-0">
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) void loadDetail()
        }}
      >
        <CollapsibleTrigger
          className={cn(
            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
            'transition-colors hover:bg-muted/50',
          )}
        >
          <BotIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">子助手 · {agent.name}</span>
          <Badge variant={statusVariant(agent.status)}>
            {statusLabel[agent.status ?? ''] ?? agent.status ?? '未知'}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {agent.stepCount ?? 0} 步 / {agent.toolCallCount ?? 0} 次工具 ·{' '}
            {formatDuration(agent.durationMs)}
            {/* 子助手自己的消耗（k / m 缩写，与右下角统计同一套口径）；
                注意它**已计入父那一轮的合计**（`rollUpUsage`），不是额外再花一份 */}
            {typeof agent.usage?.totalTokens === 'number'
              ? ` · ${tokenText(agent.usage.totalTokens)} token`
              : ''}
          </span>
          <ChevronDownIcon
            className={cn('ml-auto size-4 transition-transform', open && 'rotate-180')}
          />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="flex flex-col gap-2 px-3 pb-3">
            {agent.reason && (
              <p className="text-xs text-warning">{agent.reason}</p>
            )}
            {reasoning && (
              <Reasoning isStreaming={agent.status === 'running'}>
                <ReasoningTrigger
                  getThinkingMessage={(streaming) => (
                    <span>{streaming ? '子助手思考中…' : '子助手思考过程'}</span>
                  )}
                />
                <ReasoningContent>{reasoning}</ReasoningContent>
              </Reasoning>
            )}
            {text && (
              <div className="rounded-md bg-muted/40 p-2 text-sm whitespace-pre-wrap">
                {text}
              </div>
            )}
            {detail?.events.map((event, index) => (
              <Tool key={index} defaultOpen={false}>
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
                      errorText={event.isError ? JSON.stringify(event.output ?? '') : undefined}
                    />
                  )}
                </ToolContent>
              </Tool>
            ))}
            {agent.error && <p className="text-xs text-destructive">{agent.error}</p>}
            {agent.loadDetail && !detail && (
              <Button size="sm" variant="ghost" disabled={loading} onClick={() => void loadDetail()}>
                {loading ? '加载中…' : '查看子助手全过程（含工具入参出参）'}
              </Button>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
