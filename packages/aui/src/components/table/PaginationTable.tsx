'use client'

import { Table } from 'antd'
import type { TablePaginationConfig, TableProps } from 'antd'

export type PaginationTableProps<RecordType extends object> = Omit<
  TableProps<RecordType>,
  'pagination' | 'loading'
> & {
  loading?: boolean
  page: number
  pageSize: number
  total?: number
  paginationProps?: Omit<
    TablePaginationConfig,
    'current' | 'pageSize' | 'total' | 'onChange'
  >
  onPageChange: (page: number, pageSize: number) => void
}

export const PaginationTable = <RecordType extends object>({
  loading,
  page,
  pageSize,
  total,
  paginationProps,
  onPageChange,
  ...tableProps
}: PaginationTableProps<RecordType>) => {
  return (
    <Table<RecordType>
      {...tableProps}
      loading={loading}
      pagination={{
        ...paginationProps,
        current: page,
        pageSize,
        total,
        onChange: onPageChange,
      }}
    />
  )
}
