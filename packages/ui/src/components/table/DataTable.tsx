'use client'

import type { ReactNode } from 'react'
import { PageToolbar } from './PageToolbar'
import { PaginationTable } from './PaginationTable'
import type { PaginationTableProps } from './PaginationTable'

export type DataTableProps<RecordType extends object> = Omit<
  PaginationTableProps<RecordType>,
  'title'
> & {
    title?: ReactNode
    toolbar?: ReactNode
    search?: ReactNode
    className?: string
    tableClassName?: string
  }

export const DataTable = <RecordType extends object>({
  title,
  toolbar,
  search,
  className,
  tableClassName,
  ...tableProps
}: DataTableProps<RecordType>) => (
  <section className={className}>
    {title || toolbar || search ? (
      <PageToolbar title={title} extra={toolbar}>
        {search}
      </PageToolbar>
    ) : null}
    <PaginationTable<RecordType> {...tableProps} className={tableClassName} />
  </section>
)
