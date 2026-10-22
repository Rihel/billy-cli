'use client'

import type { ReactNode } from 'react'

import { cn } from '#lib/utils'
import { Label } from '#components/ui/label'
import { RadioGroup, RadioGroupItem } from '#components/ui/radio-group'

export type SegmentedOption = {
  label: ReactNode
  value: string
  disabled?: boolean
}

export type SegmentedControlProps = {
  value?: string | null
  options: SegmentedOption[]
  onValueChange?: (value: string) => void
  disabled?: boolean
  size?: 'sm' | 'default'
  className?: string
}

/**
 * 分段选择（胶囊样式）。
 *
 * 用途：**选项很少的枚举**（≤4 项）—— 用户一眼能看全，不需要点开下拉再挑。
 * 语义仍是单选组（`RadioGroup`），键盘方向键可用；选项多（>4）请继续用 `DictSelect`。
 * 与「7 天 / 30 天」那种切换同一套视觉：容器 `surface-3`，选中项品牌淡底。
 */
export function SegmentedControl({
  value,
  options,
  onValueChange,
  disabled,
  size = 'default',
  className,
}: SegmentedControlProps) {
  return (
    <RadioGroup
      value={value ?? null}
      onValueChange={(next) => onValueChange?.(String(next ?? ''))}
      disabled={disabled}
      className={cn(
        // 焦点环画在整组上（每项自己带环会在选中项外面再套一圈，看起来像没对齐）
        'inline-flex w-fit flex-row items-center gap-0.5 rounded-lg bg-surface-3 p-0.5 focus-within:ring-2 focus-within:ring-ring/50',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <Label
            key={option.value}
            className={cn(
              'relative cursor-pointer gap-0 rounded-md px-3 text-xs font-normal transition-colors',
              size === 'sm' ? 'h-6' : 'h-7',
              active
                ? 'bg-brand/12 font-medium text-brand'
                : 'text-muted-foreground hover:text-foreground',
              option.disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {/* 单选框本体不占位：绝对铺满整格、透明。
                用 `sr-only` 不行 —— 它的 position/size 会被 RadioGroupItem 自带的
                `relative` / `size-4` 按 CSS 顺序盖掉，结果 16px 的圆点挤在文字前面，
                选中格被撑宽、文字看着偏右。 */}
            <RadioGroupItem
              value={option.value}
              disabled={option.disabled}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
            {option.label}
          </Label>
        )
      })}
    </RadioGroup>
  )
}
