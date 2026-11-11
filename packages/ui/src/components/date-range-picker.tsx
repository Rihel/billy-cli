'use client'

import { useState } from 'react'
import type { DateRange } from 'react-day-picker'
import { CalendarIcon } from 'lucide-react'

import { Button } from '#components/ui/button.tsx'
import { Calendar } from '#components/ui/calendar.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '#components/ui/popover.tsx'
import { cn } from '#lib/utils.ts'

export interface DateRangeValue {
  /** YYYY-MM-DD */
  from?: string
  /** YYYY-MM-DD */
  to?: string
}

export interface DateRangePickerProps {
  value?: DateRangeValue
  onChange: (value: DateRangeValue) => void
  placeholder?: string
  className?: string
}

const parseDay = (value?: string): Date | undefined => {
  if (!value) return undefined
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return undefined
  return new Date(year, month - 1, day)
}

const formatDay = (value?: Date): string | undefined => {
  if (!value) return undefined
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(
    value.getDate(),
  ).padStart(2, '0')}`
}

/**
 * 日期范围选择（Calendar + Popover 的薄封装）。
 *
 * 为什么不用 `<input type="date">`：范围筛选要同时看清起止两天、支持点选与清除；
 * 原生 input 是单日期控件，拼两个还会出现「结束早于开始」这种无效状态。
 */
export function DateRangePicker({
  value,
  onChange,
  placeholder = '全部时间',
  className,
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false)
  const range: DateRange = {
    from: parseDay(value?.from),
    to: parseDay(value?.to),
  }

  const label =
    value?.from && value?.to
      ? `${value.from} ~ ${value.to}`
      : value?.from
        ? `${value.from} 起`
        : value?.to
          ? `截至 ${value.to}`
          : placeholder

  const select = (next: DateRange | undefined) => {
    onChange({ from: formatDay(next?.from), to: formatDay(next?.to) })
    if (next?.from && next?.to) setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn('justify-start gap-1.5 font-normal', className)}
            aria-label="选择时间范围"
          />
        }
      >
        <CalendarIcon className="size-3.5" />
        {label}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="range"
          selected={range}
          onSelect={select}
          numberOfMonths={2}
          defaultMonth={range.from}
        />
        <div className="flex justify-end border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange({})
              setOpen(false)
            }}
          >
            清除
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
