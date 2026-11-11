"use client"

import { useState } from "react"
import type { ReactNode } from "react"
import {
  columnVisibilityFeature,
  coreFeatures,
  flexRender,
  useTable,
  type ColumnDef,
} from "@tanstack/react-table"

import { cn } from "#lib/utils"
import { Button } from "#components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "#components/ui/empty"
import { PageToolbar } from "#components/page-toolbar"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#components/ui/select"
import { Skeleton } from "#components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#components/ui/table"
import { ChevronLeftIcon, ChevronRightIcon, InboxIcon } from "lucide-react"

/** 只启用列可见性与 core：服务端分页，不需要前端排序 / 分页 / 过滤特性 */
const tableFeatures = { ...coreFeatures, columnVisibilityFeature }
type DataTableFeatures = typeof tableFeatures

/** tanstack 列定义：meta.width 用于控制列宽；meta.sticky 可显式把操作列固定在右侧 */
export type DataTableColumnDef<T extends object> = ColumnDef<DataTableFeatures, T, any> & {
  meta?: {
    width?: number
    sticky?: 'right'
  }
}

/** 操作列识别：id=actions / 表头“操作” / 显式 meta.sticky=right */
const isActionsColumn = (column: {
  id: string
  columnDef: { header?: unknown; meta?: { sticky?: 'right' } }
}): boolean => {
  if (column.columnDef.meta?.sticky === 'right') return true
  if (column.id === 'actions' || column.id.endsWith('Actions')) return true
  return typeof column.columnDef.header === 'string' && column.columnDef.header.trim() === '操作'
}

export type DataTableProps<T extends object> = {
  columns: DataTableColumnDef<T>[]
  data?: T[]
  loading?: boolean
  /** 行唯一键：字段名或取值函数 */
  rowKey: string | ((row: T) => string)
  /** 当前页（1 起） */
  page?: number
  /** 每页条数 */
  pageSize?: number
  /** 总条数（服务端分页时传入） */
  total?: number
  onPageChange?: (page: number, pageSize: number) => void
  /** 每页条数选项（默认 [10, 20, 50]） */
  pageSizeOptions?: number[]
  title?: ReactNode
  /** 标题下方的说明文案（透传 PageToolbar） */
  description?: ReactNode
  toolbar?: ReactNode
  search?: ReactNode
  emptyText?: ReactNode
  className?: string
  tableClassName?: string
}

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50]

/**
 * 服务端分页数据表格（@tanstack/react-table）。
 * 列定义用 DataTableColumnDef（header / accessorKey / cell / meta.width）。
 */
export function DataTable<T extends object>({
  columns,
  data,
  loading,
  rowKey,
  page,
  pageSize: pageSizeProp,
  total,
  onPageChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  title,
  description,
  toolbar,
  search,
  emptyText = "暂无数据",
  className,
  tableClassName,
}: DataTableProps<T>) {
  const [pageSize, setPageSize] = useState(pageSizeProp ?? pageSizeOptions[0])
  const currentPage = Math.max(page ?? 1, 1)
  const currentPageSize = pageSizeProp ?? pageSize
  const totalCount = total ?? data?.length ?? 0
  const totalPages = Math.max(Math.ceil(totalCount / currentPageSize), 1)

  const table = useTable<DataTableFeatures, T>({
    features: tableFeatures,
    data: data ?? [],
    columns,
    getRowId:
      typeof rowKey === "function"
        ? rowKey
        : (row) => String((row as Record<string, unknown>)[rowKey]),
  })

  const rows = table.getRowModel().rows
  const headerGroups = table.getHeaderGroups()

  const renderPagination = page !== undefined || total !== undefined

  return (
    <section className={cn("flex flex-col gap-4", className)}>
      {title || description || toolbar || search ? (
        <PageToolbar title={title} description={description} extra={toolbar}>
          {search}
        </PageToolbar>
      ) : null}

      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-xl bg-card",
          tableClassName,
        )}
      >
        <Table>
          <TableHeader className="bg-surface-2/60">
            {headerGroups.map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => {
                  const width = (header.column.columnDef.meta as { width?: number } | undefined)?.width
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(
                        'h-10 px-3 text-xs font-medium tracking-wide text-muted-foreground',
                        isActionsColumn(header.column) &&
                          'sticky right-0 z-20 bg-surface-2 shadow-[-1px_0_0_0_var(--border)]',
                      )}
                      style={width ? { width } : undefined}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 ? (
              Array.from({ length: 5 }).map((_, rowIndex) => (
                <TableRow key={rowIndex}>
                  {headerGroups[0]?.headers.map((header) => (
                    <TableCell key={header.id} className="p-3">
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length > 0 ? (
              rows.map((row) => (
                <TableRow key={row.id} className="group">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        'px-3 py-2.5 text-[13px]',
                        isActionsColumn(cell.column) &&
                          'sticky right-0 z-10 bg-card shadow-[-1px_0_0_0_var(--border)] group-hover:bg-surface-2/70',
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-40 p-3 text-center"
                >
                  <Empty className="border-0">
                    <EmptyMedia variant="icon">
                      <InboxIcon />
                    </EmptyMedia>
                    <EmptyTitle>暂无数据</EmptyTitle>
                    <EmptyDescription className="text-sm text-muted-foreground">
                      {emptyText}
                    </EmptyDescription>
                  </Empty>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        {renderPagination ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-1 px-3 py-2.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-3">
              <span className="font-mono tabular-nums text-foreground/80">
                共 {totalCount} 条
              </span>
              <Select
                value={String(currentPageSize)}
                onValueChange={(value) => {
                  const nextSize = Number(value)
                  setPageSize(nextSize)
                  onPageChange?.(1, nextSize)
                }}
              >
                <SelectTrigger size="sm" className="h-7 w-auto gap-1 border-0 bg-transparent px-0 text-muted-foreground shadow-none hover:text-foreground">
                  <SelectValue />
                  <span className="font-mono">/页</span>
                </SelectTrigger>
                <SelectContent>
                  {pageSizeOptions.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size} 条/页
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="上一页"
                disabled={currentPage <= 1}
                onClick={() => onPageChange?.(currentPage - 1, currentPageSize)}
              >
                <ChevronLeftIcon />
              </Button>
              <span className="px-1 font-mono tabular-nums text-foreground/70">
                {currentPage}
                <span className="mx-1 text-muted-foreground/50">/</span>
                {totalPages}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="下一页"
                disabled={currentPage >= totalPages}
                onClick={() => onPageChange?.(currentPage + 1, currentPageSize)}
              >
                <ChevronRightIcon />
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
