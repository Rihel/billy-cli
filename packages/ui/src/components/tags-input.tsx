"use client"

import { useId, useState } from "react"
import type { KeyboardEvent } from "react"

import { cn } from "#lib/utils"
import { Badge } from "#components/ui/badge"
import { Input } from "#components/ui/input"
import { XIcon } from "lucide-react"

export type TagInputOption = {
  label: string
  value: string
}

export type TagsInputProps = {
  value: string[]
  onChange: (next: string[]) => void
  /** 建议选项（可自由输入不在选项中的值） */
  options?: TagInputOption[]
  /** 最大数量（默认不限；如指标字段 maxCount=1） */
  maxCount?: number
  placeholder?: string
  disabled?: boolean
  className?: string
}

/** 标签输入（chip + 自由文本，回车 / 逗号 / 失焦提交，Backspace 删除最后一个） */
export function TagsInput({
  value = [],
  onChange,
  options = [],
  maxCount,
  placeholder,
  disabled,
  className,
}: TagsInputProps) {
  const listId = useId()
  const [draft, setDraft] = useState("")
  const reachLimit = maxCount !== undefined && value.length >= maxCount

  const add = (raw: string) => {
    const next = raw.trim()
    if (!next) return
    if (maxCount !== undefined && value.length >= maxCount) return
    if (value.includes(next)) return
    onChange([...value, next])
    setDraft("")
  }

  const remove = (target: string) =>
    onChange(value.filter((item) => item !== target))

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault()
      add(draft)
    } else if (event.key === "Backspace" && !draft && value.length > 0) {
      remove(value[value.length - 1])
    }
  }

  return (
    <div
      className={cn(
        "flex min-h-8 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 py-1 text-sm transition-colors outline-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      {value.map((item) => (
        <Badge key={item} variant="secondary" className="gap-1 py-0 pr-1 pl-2">
          {item}
          <button
            type="button"
            aria-label={`删除 ${item}`}
            disabled={disabled}
            className="rounded-full p-0.5 transition-colors hover:bg-muted disabled:pointer-events-none"
            onClick={() => remove(item)}
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
      {!reachLimit ? (
        <>
          <Input
            className="h-6 w-32 min-w-0 flex-1 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
            list={options.length ? listId : undefined}
            value={draft}
            disabled={disabled}
            placeholder={
              placeholder ?? (value.length === 0 ? "输入后回车添加" : "")
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (draft.trim()) add(draft)
            }}
          />
          {options.length ? (
            <datalist id={listId}>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </datalist>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
