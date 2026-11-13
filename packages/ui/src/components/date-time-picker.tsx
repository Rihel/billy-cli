'use client'

import { useState } from 'react'
import { CalendarIcon } from 'lucide-react'

import { Button } from '#components/ui/button.tsx'
import { Calendar } from '#components/ui/calendar.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '#components/ui/popover.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select.tsx'
import { cn } from '#lib/utils.ts'

/**
 * 日期 + 时间选择（`Calendar` + `Popover` 的薄封装，和 `DateRangePicker` 同一套原语）。
 *
 * 为什么不用 `<input type="datetime-local">`：原生控件在深色模式、禁用态、清除、
 * 「早于下限的时间」这些地方全都只能靠浏览器默认样式，和设计系统两套皮；
 * 而日期面板本来就是 UI 包里已有的 `Calendar`，再拼两个时间下拉即可。
 *
 * 值格式是 `YYYY-MM-DDTHH:mm`（与原生控件同构，方便表单直接存字符串），
 * 加 `min` 可以把过去的日期灰掉。
 */

export interface DateTimePickerProps {
  /** `YYYY-MM-DDTHH:mm` */
  value?: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  /** 早于该时刻的日期不可选 */
  min?: Date
  disabled?: boolean
}

const pad = (value: number): string => String(value).padStart(2, '0')

const parse = (value?: string): { day: Date | undefined; hour: number; minute: number } => {
  const [datePart, timePart] = (value ?? '').split('T')
  const [year, month, date] = (datePart ?? '').split('-').map(Number)
  const [hour, minute] = (timePart ?? '').split(':').map(Number)
  if (!year || !month || !date) return { day: undefined, hour: 9, minute: 0 }
  return {
    day: new Date(year, month - 1, date),
    hour: Number.isFinite(hour) ? hour : 9,
    minute: Number.isFinite(minute) ? minute : 0,
  }
}

const format = (day: Date, hour: number, minute: number): string =>
  `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T${pad(hour)}:${pad(minute)}`

const HOURS = Array.from({ length: 24 }, (_, index) => index)
const MINUTES = Array.from({ length: 60 }, (_, index) => index)

export function DateTimePicker({
  value,
  onChange,
  placeholder = '选择日期时间',
  className,
  min,
  disabled,
}: DateTimePickerProps) {
  const [open, setOpen] = useState(false)
  const initial = parse(value)
  const [day, setDay] = useState<Date | undefined>(initial.day)
  const [hour, setHour] = useState(initial.hour)
  const [minute, setMinute] = useState(initial.minute)

  // 每次打开都从当前值重新起算，避免上次未确认的临时选择残留
  const handleOpenChange = (next: boolean) => {
    if (next) {
      const current = parse(value)
      setDay(current.day)
      setHour(current.hour)
      setMinute(current.minute)
    }
    setOpen(next)
  }

  const commit = () => {
    if (!day) return
    onChange(format(day, hour, minute))
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className={cn(
              'w-full justify-start gap-1.5 font-normal',
              !value && 'text-muted-foreground',
              className,
            )}
            aria-label="选择日期时间"
          />
        }
      >
        <CalendarIcon className="size-3.5" />
        {value ? value.replace('T', ' ') : placeholder}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={day}
          onSelect={setDay}
          defaultMonth={day}
          disabled={min ? { before: min } : undefined}
        />
        <div className="flex items-center gap-2 border-t p-2">
          <Select value={String(hour)} onValueChange={(next) => setHour(Number(next))}>
            <SelectTrigger className="h-8 w-[84px]" aria-label="小时">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOURS.map((item) => (
                <SelectItem key={item} value={String(item)}>
                  {pad(item)} 时
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(minute)} onValueChange={(next) => setMinute(Number(next))}>
            <SelectTrigger className="h-8 w-[84px]" aria-label="分钟">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MINUTES.map((item) => (
                <SelectItem key={item} value={String(item)}>
                  {pad(item)} 分
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
            >
              清除
            </Button>
            <Button type="button" size="sm" disabled={!day} onClick={commit}>
              确定
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
