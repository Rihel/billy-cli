'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge, Button, cn } from '@repo/ui'
// ai-elements 走子路径（不进 barrel，见 docs/design/ai-agent.md §1）
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorLogoGroup,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '@repo/ui/components/ai-elements/model-selector.tsx'
import type { AiAvailableModelModel } from '@repo/shared'
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'

/**
 * 模型选择器（会话页顶部）—— **只列后台配过且启用的模型**。
 *
 * 数据源是 `POST /agent/models`（服务端按"供应商启用 + 模型启用"过滤，见设计文档 §4.9）：
 * 选择器里能看到的每一个模型都是确定能用的，不存在"选了之后才发现不能用"。
 *
 * 库空时不给可点的入口，直接提示去后台配 —— 这是"agent 只能使用配的模型"的界面表达。
 */
export function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  /** 当前选中的 `ai_models.id`（未选 = 用服务端默认） */
  value?: string
  onChange: (modelId: string) => void
  disabled?: boolean
}) {
  const client = useServerClient()
  const [open, setOpen] = useState(false)

  const { data, isFetching } = useQuery({
    queryKey: ['ai', 'available-models'],
    queryFn: () => client.agent.models(),
  })

  const models = data?.models ?? []
  const current = useMemo(
    () => models.find((item) => item.id === value) ?? models.find((item) => item.id === data?.defaultModelId),
    [data?.defaultModelId, models, value],
  )

  // 按供应商分组：同一家的模型放一起，便于在长列表里找
  const grouped = useMemo(() => {
    const byProvider = new Map<string, AiAvailableModelModel[]>()
    for (const model of models) {
      const list = byProvider.get(model.providerName)
      if (list) list.push(model)
      else byProvider.set(model.providerName, [model])
    }
    return [...byProvider.entries()]
  }, [models])

  if (!isFetching && models.length === 0) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        还没有可用的模型：请到「模型管理」添加供应商并启用模型
      </Badge>
    )
  }

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger
        render={
          <Button variant="outline" size="sm" disabled={disabled} className="max-w-56 gap-2">
            <span className="truncate">{current?.displayName ?? '选择模型'}</span>
            <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-60" />
          </Button>
        }
      />
      <ModelSelectorContent title="选择模型">
        <ModelSelectorInput placeholder="搜索模型…" />
        <ModelSelectorList>
          <ModelSelectorEmpty>没有匹配的模型</ModelSelectorEmpty>
          {grouped.map(([providerName, items]) => (
            <ModelSelectorGroup key={providerName} heading={providerName}>
              {items.map((model) => (
                <ModelSelectorItem
                  key={model.id}
                  value={`${model.modelRef} ${model.displayName}`}
                  onSelect={() => {
                    onChange(model.id)
                    setOpen(false)
                  }}
                >
                  <ModelSelectorLogoGroup>
                    {/* 图标来自 models.dev；provider slug 对不上时浏览器会静默失败，不影响使用 */}
                    <ModelSelectorLogo provider={model.providerSlug} />
                  </ModelSelectorLogoGroup>
                  <ModelSelectorName>{model.displayName}</ModelSelectorName>
                  <span className="font-mono text-xs text-muted-foreground">{model.modelRef}</span>
                  {model.contextWindow ? (
                    <span className="text-xs text-muted-foreground">
                      {Math.round(model.contextWindow / 1000)}K
                    </span>
                  ) : null}
                  <CheckIcon
                    className={cn('ml-2 size-4', current?.id === model.id ? 'opacity-100' : 'opacity-0')}
                  />
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  )
}
