'use client'

import { CheckOutlined, CopyOutlined } from '@ant-design/icons'
import { formatTime, formatTimeInTimezone, isAvailableData } from '@repo/shared'
import type { ConfigType } from '@repo/shared'
import { copy } from '@repo/shared/browser'
import { useBoolean } from 'ahooks'
import { Button, Image, Tooltip } from 'antd'
import { useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { cn } from '../../lib/css'
import { DictTag } from './DictTag'
import type { DictLike } from './DictTag'

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

export const DisplayValue = ({
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
}: DisplayValueProps): ReactNode => {
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
      (((labelField
        ? dict.getOption(value)?.[labelField]
        : dict.getLabel(value, language)) ?? emptyText) as ReactNode)
    )
  }

  if (type === 'link') {
    const link = (
      <a
        className={cn('text-blue-600 hover:underline', className)}
        style={style}
        href={String(value)}
        target={linkTarget}
        rel={linkTarget === '_blank' ? 'noreferrer' : undefined}
      >
        {linkText ?? String(value)}
      </a>
    )
    return copyable ? (
      <CopyableText value={String(value)}>{link}</CopyableText>
    ) : (
      link
    )
  }

  if (type === 'image') {
    return (
      <Image
        src={String(value)}
        alt={imageAlt}
        className={className}
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
    <Tooltip title={actualValue}>
      <span className={className} style={style}>
        {actualValue}
      </span>
    </Tooltip>
  ) : (
    <span className={className} style={style}>
      {actualValue}
    </span>
  )

  return copyable ? (
    <CopyableText value={String(value)}>{content}</CopyableText>
  ) : (
    content
  )
}
