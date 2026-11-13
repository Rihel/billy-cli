'use client'

import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { formatTime, formatTimeInTimezone, isAvailableData } from '@repo/shared'
import type { ConfigType } from '@repo/shared'
import { copy } from '@repo/shared/browser'

import { cn } from '#lib/utils'
import { Button } from '#components/ui/button'
import { Tag } from '#components/tag'
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip'
import { CheckIcon, CopyIcon } from 'lucide-react'

export type DictOption = Record<string, unknown> & {
  color?: string
}

export type DictLike = {
  getOption(value: unknown): DictOption | undefined
  getLabel(value: unknown, language?: string): ReactNode
}

export type DictTagProps = {
  dict: DictLike
  value: unknown
  language?: string
  labelField?: string
  emptyText?: ReactNode
  className?: string
}

/** 字典标签（Tag 封装，读字典 option.color） */
export function DictTag({
  dict,
  value,
  language,
  labelField,
  emptyText = null,
  className,
}: DictTagProps) {
  const option = dict.getOption(value)
  if (!option) return emptyText

  const label = labelField ? option[labelField] : dict.getLabel(value, language)
  return (
    <Tag className={className} color={option.color}>
      {label as ReactNode}
    </Tag>
  )
}

export type EmptyValueProps = {
  value: unknown
  children: ReactNode
  emptyText?: ReactNode
}

/** 空值占位：value 为空时渲染 emptyText（默认 -） */
export function EmptyValue({ value, children, emptyText = '-' }: EmptyValueProps) {
  return value === null || value === undefined || value === '' ? emptyText : children
}

export type DateValueProps = {
  value?: ConfigType | null
  format?: string
  emptyText?: ReactNode
}

/** 日期展示（@repo/shared formatTime） */
export function DateValue({
  value,
  format = 'YYYY-MM-DD HH:mm:ss',
  emptyText = '-',
}: DateValueProps) {
  if (value === null || value === undefined || value === '') return emptyText
  return formatTime(value, format) as ReactNode
}

export type EllipsisTextProps = {
  children: ReactNode
  lines?: number
  tooltip?: boolean
  className?: string
}

/** 文本截断（1 行或 N 行省略，可选 tooltip 查看全文） */
export function EllipsisText({
  children,
  lines = 1,
  tooltip = true,
  className,
}: EllipsisTextProps) {
  const content = (
    <span
      className={cn('overflow-hidden text-ellipsis', className)}
      style={
        lines > 1
          ? ({
              display: '-webkit-box',
              WebkitLineClamp: lines,
              WebkitBoxOrient: 'vertical',
            } as CSSProperties)
          : { display: 'block', whiteSpace: 'nowrap' }
      }
    >
      {children}
    </span>
  )
  return tooltip ? (
    <Tooltip>
      <TooltipTrigger render={content} />
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  ) : (
    content
  )
}

export type CopyableTextProps = {
  value: string | number
  children?: ReactNode
  className?: string
}

/** 可复制文本：hover 出现复制按钮，复制后短暂显示「已复制」 */
export function CopyableText({ value, children, className }: CopyableTextProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timeout)
  }, [copied])

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {children ?? value}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="复制"
              onClick={() => {
                void copy(String(value)).then(() => setCopied(true))
              }}
            />
          }
        >
          {copied ? <CheckIcon className="text-emerald-600" /> : <CopyIcon />}
        </TooltipTrigger>
        <TooltipContent>{copied ? '已复制' : '复制'}</TooltipContent>
      </Tooltip>
    </span>
  )
}

export type DisplayValueProps = {
  value?: unknown
  type?: 'text' | 'date' | 'dict' | 'link' | 'image'
  emptyText?: ReactNode
  format?: string
  timezone?: string
  dict?: DictLike
  language?: string
  labelField?: string
  tag?: boolean
  ellipsis?: boolean
  ellipsisLine?: number
  tooltip?: boolean
  copyable?: boolean
  linkText?: ReactNode
  linkTarget?: '_blank' | '_self'
  imageAlt?: string
  className?: string
  style?: CSSProperties
}

/** 通用值展示：text / date / dict / link / image，支持省略、复制、tooltip */
export function DisplayValue({
  value,
  type = 'text',
  emptyText = '-',
  format = 'YYYY-MM-DD HH:mm:ss',
  timezone,
  dict,
  language,
  labelField,
  tag = false,
  ellipsis = false,
  ellipsisLine = 1,
  tooltip = false,
  copyable = false,
  linkText,
  linkTarget = '_self',
  imageAlt = '',
  className,
  style,
}: DisplayValueProps): ReactNode {
  if (!isAvailableData(value)) return emptyText

  if (type === 'dict' && dict) {
    return tag ? (
      <DictTag
        dict={dict}
        value={value}
        language={language}
        labelField={labelField}
        className={className}
        emptyText={emptyText}
      />
    ) : (
      (((labelField ? dict.getOption(value)?.[labelField] : dict.getLabel(value, language)) ??
        emptyText) as ReactNode)
    )
  }

  if (type === 'link') {
    const link = (
      <a
        className={cn('text-primary hover:underline', className)}
        style={style}
        href={String(value)}
        target={linkTarget}
        rel={linkTarget === '_blank' ? 'noreferrer' : undefined}
      >
        {linkText ?? String(value)}
      </a>
    )
    return copyable ? <CopyableText value={String(value)}>{link}</CopyableText> : link
  }

  if (type === 'image') {
    return (
      <img
        src={String(value)}
        alt={imageAlt}
        className={cn('object-cover', className)}
        style={style}
      />
    )
  }

  const actualValue =
    type === 'date'
      ? timezone
        ? formatTimeInTimezone(value as ConfigType, timezone, format)
        : formatTime(value as ConfigType, format)
      : (value as ReactNode)
  const content = ellipsis ? (
    <EllipsisText lines={ellipsisLine} tooltip={tooltip} className={className}>
      {actualValue}
    </EllipsisText>
  ) : tooltip ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={className} style={style}>
            {actualValue}
          </span>
        }
      />
      <TooltipContent>{actualValue}</TooltipContent>
    </Tooltip>
  ) : (
    <span className={className} style={style}>
      {actualValue}
    </span>
  )

  return copyable ? <CopyableText value={String(value)}>{content}</CopyableText> : content
}
