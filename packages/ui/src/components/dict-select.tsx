'use client'

import type { ReactNode } from 'react'

import { cn } from '#lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select'
import type { DictLike } from '#components/display'

export type DictSelectOption = {
  label: ReactNode
  value: string | number
}

/** 可传入的字典：createDict 产物（含 options）满足该结构 */
export type DictSelectDict = DictLike & {
  options: DictSelectOption[]
}

export type DictSelectProps = {
  /** 字典（createDict 产物）：提供 options / getLabel，优先于手写 options */
  dict?: DictSelectDict
  /** 手写选项（dict 未提供时使用） */
  options?: DictSelectOption[]
  /** 当前值（null 表示未选中；数字字典 value 请在调用方 String() 后传入） */
  value?: string | null
  onValueChange?: (value: string | null) => void
  /** 是否提供「全部」选项（value 为 all，选中后回调 null） */
  allowClear?: boolean
  /** 未选中时的占位文案（默认「请选择」） */
  placeholder?: ReactNode
  size?: 'sm' | 'default'
  /** SelectContent 容器类 */
  className?: string
  /** SelectTrigger 类 */
  triggerClassName?: string
  disabled?: boolean
}

const isAll = (v: unknown) => v === 'all'

/**
 * 字典下拉（Select 封装）。
 *
 * 用 base-ui SelectValue 的自定义 children 渲染，直接按字典 / options 解析 label，
 * 不依赖 base-ui 内部 items 注册（Popup 未打开时解析不到 label 会回退显示原始 value）。
 */
export function DictSelect({
  dict,
  options,
  value,
  onValueChange,
  allowClear = false,
  placeholder = '请选择',
  size,
  className,
  triggerClassName,
  disabled,
}: DictSelectProps) {
  const items: DictSelectOption[] = dict?.options ?? options ?? []

  const resolveLabel = (selected: unknown): ReactNode => {
    if (selected == null || selected === '') {
      return placeholder
    }
    if (isAll(selected)) {
      return '全部'
    }
    if (dict) {
      const label = dict.getLabel(selected)
      if (label !== undefined && label !== null && label !== '') {
        return label
      }
    }
    return (
      items.find((option) => String(option.value) === String(selected))?.label ?? String(selected)
    )
  }

  return (
    <Select
      value={value ?? null}
      disabled={disabled}
      onValueChange={(next) => {
        if (allowClear && isAll(next)) {
          onValueChange?.(null)
          return
        }
        onValueChange?.(next ?? null)
      }}
    >
      <SelectTrigger size={size} className={cn('w-fit', triggerClassName)}>
        <SelectValue>
          {(selected) => (
            <span
              className={cn(
                'truncate',
                selected == null || selected === '' || isAll(selected)
                  ? 'text-muted-foreground'
                  : 'text-foreground',
              )}
            >
              {resolveLabel(selected)}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className={className}>
        {allowClear ? <SelectItem value="all">全部</SelectItem> : null}
        {items.map((option) => (
          <SelectItem key={String(option.value)} value={String(option.value)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
