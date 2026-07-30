'use client'

import { Empty, Spin } from 'antd'
import { forwardRef, useImperativeHandle, useRef } from 'react'
import type { CSSProperties, ReactNode, Ref } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { VirtuosoHandle } from 'react-virtuoso'
import { cn } from '../../lib/css'

export type DataListApi = {
  scrollToIndex(index: number, align?: 'start' | 'center' | 'end'): void
  scrollToTop(): void
  scrollToEnd(): void
}

export type DataListProps<Item> = {
  dataSource?: Item[]
  loading?: boolean
  hasMore?: boolean
  loadingMore?: boolean
  emptyText?: ReactNode
  loadingText?: ReactNode
  header?: ReactNode
  footer?: ReactNode
  renderItem: (item: Item, index: number) => ReactNode
  onLoadMore?: () => void | Promise<void>
  rowKey?: keyof Item | ((item: Item) => React.Key)
  height?: CSSProperties['height']
  overscan?: number
  className?: string
  listClassName?: string
  style?: CSSProperties
}

const DataListInner = <Item,>(
  {
    dataSource,
    loading,
    hasMore = false,
    loadingMore = false,
    emptyText = '暂无数据',
    loadingText = '加载中...',
    header,
    footer,
    renderItem,
    onLoadMore,
    rowKey,
    height = 480,
    overscan = 300,
    className,
    listClassName,
    style,
  }: DataListProps<Item>,
  ref: Ref<DataListApi>,
) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const items = dataSource ?? []

  useImperativeHandle(ref, () => ({
    scrollToIndex(index, align = 'start') {
      virtuosoRef.current?.scrollToIndex({ index, align })
    },
    scrollToTop() {
      virtuosoRef.current?.scrollToIndex({ index: 0, align: 'start' })
    },
    scrollToEnd() {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' })
    },
  }))

  const computeItemKey = rowKey
    ? (_index: number, item: Item) =>
        typeof rowKey === 'function'
          ? rowKey(item)
          : (item[rowKey] as React.Key)
    : undefined

  return (
    <section className={className} style={style}>
      {header ? <div className="mb-4">{header}</div> : null}
      <Virtuoso<Item>
        ref={virtuosoRef}
        className={cn('w-full', listClassName)}
        style={{ height }}
        data={items}
        overscan={overscan}
        computeItemKey={computeItemKey}
        itemContent={(index, item) => renderItem(item, index)}
        endReached={() => {
          if (hasMore && !loading && !loadingMore) void onLoadMore?.()
        }}
        components={{
          EmptyPlaceholder: () =>
            loading ? (
              <div className="flex h-full items-center justify-center">
                <Spin description={loadingText} />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center">
                <Empty description={emptyText} />
              </div>
            ),
          Footer: () =>
            loadingMore ? (
              <div className="flex justify-center py-4">
                <Spin size="small" description={loadingText} />
              </div>
            ) : null,
        }}
      />
      {footer ? <div className="mt-4">{footer}</div> : null}
    </section>
  )
}

export const DataList = forwardRef(DataListInner) as <Item>(
  props: DataListProps<Item> & { ref?: Ref<DataListApi> },
) => ReactNode
