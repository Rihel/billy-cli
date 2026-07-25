'use client'

import { Button, List } from 'antd'
import type { ListProps } from 'antd'
import type { ReactNode } from 'react'

export type DataListProps<Item> = Omit<
  ListProps<Item>,
  'dataSource' | 'loading' | 'loadMore' | 'renderItem'
> & {
  dataSource?: Item[]
  loading?: boolean
  hasMore?: boolean
  loadingMore?: boolean
  loadMoreText?: ReactNode
  renderItem: (item: Item, index: number) => ReactNode
  onLoadMore?: () => void | Promise<void>
}

export const DataList = <Item,>({
  dataSource,
  loading,
  hasMore = false,
  loadingMore = false,
  loadMoreText = '加载更多',
  renderItem,
  onLoadMore,
  ...listProps
}: DataListProps<Item>) => (
  <List<Item>
    {...listProps}
    dataSource={dataSource}
    loading={loading && !dataSource?.length}
    renderItem={renderItem}
    loadMore={
      hasMore && onLoadMore ? (
        <div className="flex justify-center py-4">
          <Button loading={loadingMore} onClick={() => void onLoadMore()}>
            {loadMoreText}
          </Button>
        </div>
      ) : null
    }
  />
)
