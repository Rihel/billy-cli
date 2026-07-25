'use client'

import { Tag } from 'antd'
import type { ReactNode } from 'react'

export type DictOption = Record<string, unknown> & {
  color?: string
}

export type DictLike = {
  getOption(value: any): DictOption | undefined
  getLabel(value: any, language?: string): ReactNode
}

export type DictTagProps = {
  dict: DictLike
  value: unknown
  language?: string
  labelField?: string
  bordered?: boolean
  emptyText?: ReactNode
  className?: string
}

export const DictTag = ({
  dict,
  value,
  language,
  labelField,
  bordered = false,
  emptyText = null,
  className,
}: DictTagProps) => {
  const option = dict.getOption(value)
  if (!option) return emptyText

  const label = labelField ? option[labelField] : dict.getLabel(value, language)
  return (
    <Tag className={className} color={option.color} bordered={bordered}>
      {label as ReactNode}
    </Tag>
  )
}
