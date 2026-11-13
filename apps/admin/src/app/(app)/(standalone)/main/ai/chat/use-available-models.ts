'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AiAvailableModelModel } from '@repo/shared'

import { useServerClient } from '@/lib/server-client'

/** 可选模型清单的查询 key（选择器与附件能力判定共用同一份缓存，不会多发请求） */
export const AVAILABLE_MODELS_QUERY_KEY = ['ai', 'available-models'] as const

export interface AvailableModelsState {
  models: AiAvailableModelModel[]
  /** 服务端默认模型的 id（用户没主动选时用它） */
  defaultModelId: string | null
  /** 本轮真正会用的模型（选了就用选的，没选就用默认） */
  current: AiAvailableModelModel | undefined
  isFetching: boolean
  isError: boolean
  error: unknown
  refetch: () => void
}

/**
 * 读"本轮会用到哪些模型、当前是哪个"。
 *
 * 为什么单独一个 hook：会话页有两处要它 —— **模型选择器**（显示与切换）和**附件能力判定**
 * （"这个模型收不收图"）。两处各自 `useQuery` 也共享同一份缓存，但口径（"当前是哪个"）
 * 只该写一次，否则选默认模型时两边的判断迟早会不一致。
 */
export const useAvailableModels = (selectedModelId?: string): AvailableModelsState => {
  const client = useServerClient()
  const query = useQuery({
    queryKey: AVAILABLE_MODELS_QUERY_KEY,
    queryFn: () => client.agent.models(),
  })

  const models = useMemo(() => query.data?.models ?? [], [query.data])
  const defaultModelId = query.data?.defaultModelId ?? null
  const current = useMemo(
    () =>
      models.find((item) => item.id === selectedModelId) ??
      models.find((item) => item.id === defaultModelId),
    [defaultModelId, models, selectedModelId],
  )

  return {
    models,
    defaultModelId,
    current,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
  }
}

/**
 * 当前模型的**输入模态**（`["text","image","file"]`；`null` = 未声明）。
 *
 * 直接读模型实体的字段（`ai_models.input_modalities`），不再从 `capabilities` 里猜字段名。
 *
 * `undefined` = **还没拿到模型清单**（加载中 / 出错）——与 `null`（拿到了、但模型没声明模态）
 * 是两件事：前者把校验交给服务端，后者按"未声明"处理（提醒但不拦）。
 */
export const currentModelModalities = (
  current: AiAvailableModelModel | undefined,
): readonly string[] | null | undefined => current?.inputModalities
