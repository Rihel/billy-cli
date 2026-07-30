'use client'

import type { ReactNode } from 'react'
import { PageToolbar } from './PageToolbar'
import { PaginationTable } from './PaginationTable'
import type { PaginationTableProps } from './PaginationTable'
import { cn } from '../../lib/css'

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
  <section className={cn(className, 'flex flex-col gap-4')}>
    {title || toolbar || search ? (
      <PageToolbar title={title} extra={toolbar}>
        {search}
      </PageToolbar>
    ) : null}
    <PaginationTable<RecordType> {...tableProps} className={tableClassName} />
  </section>
)
