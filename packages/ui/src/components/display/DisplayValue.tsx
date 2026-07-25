'use client'

import { CheckOutlined, CopyOutlined } from '@ant-design/icons'
import { formatTime } from '@repo/shared'
import type { ConfigType } from '@repo/shared'
import { copy } from '@repo/shared/browser'
import { useBoolean } from 'ahooks'
import { Button, Tag, Tooltip } from 'antd'
import { useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { cn } from '../../lib/css'

export type EmptyValueProps = {
  value: unknown
  children: ReactNode
  emptyText?: ReactNode
}

export const EmptyValue = ({
  value,
  children,
  emptyText = '-',
}: EmptyValueProps) => {
  return value === null || value === undefined || value === ''
    ? emptyText
    : children
}

export type DateValueProps = {
  value?: ConfigType | null
  format?: string
  emptyText?: ReactNode
}

export const DateValue = ({
  value,
  format = 'YYYY-MM-DD HH:mm:ss',
  emptyText = '-',
}: DateValueProps) => {
  if (value === null || value === undefined || value === '') return emptyText
  return formatTime(value, format) as ReactNode
}

export type DictLike = {
  getOption(value: any): Record<string, any> | undefined
  getLabel(value: any, language?: string): string
}

export type DictTagProps = {
  dict: DictLike
  value: unknown
  language?: string
  bordered?: boolean
  emptyText?: ReactNode
  className?: string
}

export const DictTag = ({
  dict,
  value,
  language,
  bordered = false,
  emptyText = '-',
  className,
}: DictTagProps) => {
  const option = dict.getOption(value)
  if (!option) return emptyText
  return (
    <Tag className={className} color={option.color} bordered={bordered}>
      {dict.getLabel(value, language)}
    </Tag>
  )
}

export type EllipsisTextProps = {
  children: ReactNode
  lines?: number
  tooltip?: boolean
  className?: string
}

export const EllipsisText = ({
  children,
  lines = 1,
  tooltip = true,
  className,
}: EllipsisTextProps) => {
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
  return tooltip ? <Tooltip title={children}>{content}</Tooltip> : content
}

export type CopyableTextProps = {
  value: string | number
  children?: ReactNode
  className?: string
}

export const CopyableText = ({
  value,
  children,
  className,
}: CopyableTextProps) => {
  const [copied, { setTrue: markCopied, setFalse: clearCopied }] = useBoolean()

  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(clearCopied, 1500)
    return () => window.clearTimeout(timeout)
  }, [clearCopied, copied])

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {children ?? value}
      <Tooltip title={copied ? '已复制' : '复制'}>
        <Button
          aria-label="复制"
          size="small"
          type="text"
          icon={copied ? <CheckOutlined /> : <CopyOutlined />}
          onClick={async () => {
            await copy(String(value))
            markCopied()
          }}
        />
      </Tooltip>
    </span>
  )
}
