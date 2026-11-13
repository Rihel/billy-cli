'use client'

import { useMemo, useState } from 'react'
import { Badge, Button } from '@repo/ui'
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
import { ChevronsUpDownIcon } from 'lucide-react'
import { useAvailableModels } from './use-available-models'

/**
 * 输入模态标记（图片 / 文件）。
 *
 * 为什么要显示出来："这个模型能不能收图"是**选了之后才知道就太晚**的信息 ——
 * 用户粘了图、点了发送，才被告知"当前模型读不了图片"，等于让他白做一遍。
 *
 * **未声明（`null`）不标**：不写"不支持"，也不写"支持" —— 我们确实不知道，
 * 标了反而让人以为结论有依据（会话页那边也一样，未声明只提醒、不拦）。
 */
function ModelModalityBadges({ inputModalities }: { inputModalities: string[] | null }) {
  const modalities = inputModalities ?? []
  const hasImage = modalities.includes('image')
  const hasFile = modalities.includes('file')
  if (!hasImage && !hasFile) return null
  return (
    <span className="flex shrink-0 items-center gap-1">
      {hasImage ? (
        <Badge variant="outline" className="px-1 py-0 text-[10px]">
          图
        </Badge>
      ) : null}
      {hasFile ? (
        <Badge variant="outline" className="px-1 py-0 text-[10px]">
          文件
        </Badge>
      ) : null}
    </span>
  )
}

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
  const [open, setOpen] = useState(false)

  const { models, current, isFetching, isError, error, refetch } = useAvailableModels(value)

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

  /**
   * 三种状态必须分清（踩过）：**加载失败** ≠ **确实没配模型**。
   *
   * 早先只判断"空数组"，于是 401（AI 接口曾只认前台用户守卫）也被显示成
   * "还没有可用的模型：请到模型管理添加" —— 把真实的鉴权错误伪装成配置问题，
   * 用户会跑去后台白折腾一圈。现在错误单独提示并给重试。
   */
  if (isError) {
    return (
      <Button
        variant="destructive"
        size="xs"
        onClick={refetch}
        title={error instanceof Error ? error.message : String(error)}
      >
        模型清单加载失败，点击重试
      </Button>
    )
  }
  if (isFetching && models.length === 0) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        正在加载模型…
      </Badge>
    )
  }
  if (models.length === 0) {
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
            {current ? <ModelModalityBadges inputModalities={current.inputModalities} /> : null}
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
                  /**
                   * 当前项打勾**用 CommandItem 自带的那个勾**（`group-data-[checked=true]` 控显隐）。
                   * 自己再画一个会多占 `8 + 16`px，行里还会出现两个勾图标 —— 窄弹窗下这笔开销
                   * 直接落在"模型名被挤没"上。
                   */
                  data-checked={current?.id === model.id ? 'true' : undefined}
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
                  <ModelModalityBadges inputModalities={model.inputModalities} />
                  {/* `provider/model` 与窗口是"辅助信息"：挤的时候让它们先缩 / 先截断，名字后让 */}
                  <span
                    className="min-w-0 shrink truncate font-mono text-xs text-muted-foreground"
                    title={model.modelRef}
                  >
                    {model.modelRef}
                  </span>
                  {model.contextWindow ? (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {Math.round(model.contextWindow / 1000)}K
                    </span>
                  ) : null}
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  )
}
