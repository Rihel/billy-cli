'use client'

import { isAvailableData, maybeFun } from '@repo/shared'
import type { MaybeFunction } from '@repo/shared'
import get from 'lodash/get'
import type { ReactNode } from 'react'

import { cn } from '#lib/utils'
import { Empty } from '#components/ui/empty'
import { Group } from '#components/group'
import type { GroupProps } from '#components/group'
import { DisplayValue } from '#components/display'
import type { DisplayValueProps } from '#components/display'

export type DisplayItem<Data extends Record<string, any>> = {
  name?: string
  label?: ReactNode
  visible?: MaybeFunction<boolean, [Data]>
  render?: (value: unknown, data: Data) => ReactNode
  displayProps?: Omit<DisplayValueProps, 'value'>
  useFieldItem?: boolean
  group?: boolean
  groupName?: ReactNode
  groupProps?: GroupProps
  groupItems?: Array<DisplayItem<Data> | DisplayItem<Data>[]>
}

export type DisplayRenderProps<Data extends Record<string, any>> = {
  data?: Data | null
  items?: Array<DisplayItem<Data> | DisplayItem<Data>[]>
  columnGap?: number
  rowGap?: number
  layout?: 'row' | 'column'
  emptyText?: ReactNode
  className?: string
  itemClassName?: string
  labelClassName?: string
  contentClassName?: string
}

/** 只读信息渲染：按 items 声明式展示 data 字段（支持分组 / 自定义渲染） */
export function DisplayRender<Data extends Record<string, any>>({
  data,
  items = [],
  columnGap = 20,
  rowGap = 16,
  layout = 'column',
  emptyText = '没有数据',
  className,
  labelClassName,
  itemClassName,
  contentClassName,
}: DisplayRenderProps<Data>) {
  if (!data) return <Empty>{emptyText}</Empty>

  const isVisible = (item: DisplayItem<Data>) => maybeFun(item.visible, data) ?? true

  const renderItem = (item: DisplayItem<Data>, key: string): ReactNode => {
    if (!isVisible(item)) return null
    if (item.group) {
      return (
        <Group {...item.groupProps} key={key} title={item.groupProps?.title ?? item.groupName}>
          {renderRows(item.groupItems ?? [], `${key}-group`)}
        </Group>
      )
    }

    const value = item.name ? get(data, item.name) : undefined
    const content = item.render ? (
      item.render(value, data)
    ) : (
      <DisplayValue {...item.displayProps} value={isAvailableData(value) ? value : undefined} />
    )

    return (
      <div key={key} className="min-w-0 flex-1">
        {item.useFieldItem === false ? (
          content
        ) : (
          <div
            className={cn(
              layout === 'row' ? 'flex items-start gap-3' : 'flex flex-col gap-1',
              itemClassName,
            )}
          >
            {item.label ? (
              <div className={cn('shrink-0 text-sm text-muted-foreground', labelClassName)}>
                {item.label}
              </div>
            ) : null}
            <div className={cn('min-w-0 text-sm text-foreground', contentClassName)}>{content}</div>
          </div>
        )}
      </div>
    )
  }

  function renderRows(rows: Array<DisplayItem<Data> | DisplayItem<Data>[]>, keyPrefix: string) {
    return rows.map((entry, index) => {
      const row = Array.isArray(entry) ? entry : [entry]
      return (
        <div
          key={`${keyPrefix}-${index}`}
          className="flex flex-wrap items-start"
          style={{ columnGap, marginBottom: rowGap }}
        >
          {row.map((item, itemIndex) =>
            renderItem(item, `${keyPrefix}-${index}-${item.name ?? itemIndex}`),
          )}
        </div>
      )
    })
  }

  return <div className={className}>{renderRows(items, 'display')}</div>
}
