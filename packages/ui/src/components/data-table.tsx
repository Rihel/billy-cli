"use client"

import { useState } from "react"
import type { ReactNode } from "react"
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table"

import { cn } from "#lib/utils"
import { Button } from "#components/ui/button"
import {
  Empty,
  EmptyDescription,
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
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

/** tanstack 列定义：meta.width 用于控制列宽 */
export type DataTableColumnDef<T extends object> = ColumnDef<T, any> & {
  meta?: {
    width?: number
  }
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

  const table = useReactTable({
    data: data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId:
      typeof rowKey === "function"
        ? rowKey
        : (row) => String((row as Record<string, unknown>)[rowKey]),
    manualPagination: true,
  })

  const rows = table.getRowModel().rows
  const headerGroups = table.getHeaderGroups()

  const renderPagination = page !== undefined || total !== undefined

  return (
    <section className={cn("flex flex-col gap-4", className)}>
      {title || toolbar || search ? (
        <PageToolbar title={title} extra={toolbar}>
          {search}
        </PageToolbar>
      ) : null}

      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-lg border border-border bg-background",
          tableClassName,
        )}
      >
        <Table>
          <TableHeader>
            {headerGroups.map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const width = (header.column.columnDef.meta as { width?: number } | undefined)?.width
                  return (
                    <TableHead
                      key={header.id}
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
                    <TableCell key={header.id}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length > 0 ? (
              rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-32 text-center"
                >
                  <Empty className="border-0">
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
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2.5 text-xs text-muted-foreground">
            <div>共 {totalCount} 条</div>
            <div className="flex items-center gap-2">
              <Select
                value={String(currentPageSize)}
                onValueChange={(value) => {
                  const nextSize = Number(value)
                  setPageSize(nextSize)
                  onPageChange?.(1, nextSize)
                }}
              >
                <SelectTrigger size="sm" className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {pageSizeOptions.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size} 条/页
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="上一页"
                disabled={currentPage <= 1}
                onClick={() => onPageChange?.(currentPage - 1, currentPageSize)}
              >
                <ChevronLeftIcon />
              </Button>
              <span>{currentPage} / {totalPages}</span>
              <Button
                variant="outline"
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
