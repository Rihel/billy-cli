'use client'

import { useState } from 'react'
import { ToolEventMode } from '@repo/shared'
import type { AiToolEventModel } from '@repo/shared'
import { Badge, Collapsible, CollapsibleContent, CollapsibleTrigger, DictTag, cn } from '@repo/ui'
import { ChevronDownIcon } from 'lucide-react'

/**
 * 工具「自定义事件」声明块（**只读**）。
 *
 * 口径与「工具信息」完全一致：事件在代码里用 `@ToolDecl({ events })` 声明，启动期镜像进
 * `ai_tools.events`；页面只把"这个工具会吐什么"如实摊开，**不提供任何编辑入口** ——
 * 后台改了库、代码没改，下次启动就被声明镜像覆盖回去，只会造出一段"改了但没用"的困惑。
 *
 * 它是**声明**不是运行记录：这里看到的是"可能发什么"，实际发没发在对话流的工具卡里看。
 */

/** payloadSchema（声明里 zod 定义的 JSON Schema 化）折叠展示；没声明数据结构时只给一句话 */
const PayloadSchemaBlock = ({ schema }: { schema: Record<string, unknown> | null }) => {
  const [open, setOpen] = useState(false)
  if (!schema) {
    return <span className="text-xs text-muted-foreground">没有声明 payload 定义（发什么由代码决定）</span>
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronDownIcon className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        {open ? '收起 payload 定义' : '展开 payload 定义'}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-2 max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
          {JSON.stringify(schema, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** 一条事件声明：name / title / mode 徽标 / description / payloadSchema */
const ToolEventDeclRow = ({ event }: { event: AiToolEventModel }) => (
  <div className="flex flex-col gap-2 rounded-md border p-3">
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">{event.title}</span>
      <Badge variant="outline" className="font-mono">
        {event.name}
      </Badge>
      <DictTag dict={ToolEventMode} value={event.mode} emptyText={event.mode} />
    </div>
    {event.description ? (
      <p className="text-xs text-muted-foreground">{event.description}</p>
    ) : null}
    <PayloadSchemaBlock schema={event.payloadSchema} />
  </div>
)

/** 事件声明列表（`events` 为空时给一句克制的空态） */
export function ToolEventsPanel({ events }: { events: AiToolEventModel[] }) {
  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground">这个工具没有声明自定义事件。</p>
  }
  return (
    <div className="flex flex-col gap-2">
      {events.map((event) => (
        <ToolEventDeclRow key={event.name} event={event} />
      ))}
    </div>
  )
}
