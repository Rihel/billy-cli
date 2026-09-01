"use client"

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import type { DragEndEvent } from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { formatFileSize } from "@repo/shared/browser"

import { cn } from "#lib/utils"
import { Button } from "#components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#components/ui/tooltip"
import {
  DownloadIcon,
  EyeIcon,
  FileIcon,
  GripVerticalIcon,
  Trash2Icon,
} from "lucide-react"
import type { StorageFileValue } from "#components/file-preview"
import { useStorageAdapter } from "#components/storage-provider"

export type SortableFileListProps = {
  files: StorageFileValue[]
  sortable?: boolean
  disabled?: boolean
  className?: string
  onChange?: (files: StorageFileValue[]) => void
  onPreview?: (file: StorageFileValue) => void
  onRemove?: (file: StorageFileValue) => void
}

type SortableFileItemProps = {
  file: StorageFileValue
  sortable: boolean
  disabled: boolean
  onPreview?: (file: StorageFileValue) => void
  onRemove?: (file: StorageFileValue) => void
}

const SortableFileItem = ({
  file,
  sortable,
  disabled,
  onPreview,
  onRemove,
}: SortableFileItemProps) => {
  const { resolveUrl } = useStorageAdapter()
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: file.key, disabled: disabled || !sortable })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-14 items-center gap-3 border-b border-border px-3 py-2 last:border-b-0",
        isDragging && "relative z-10 bg-popover shadow-md",
      )}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.85 : 1,
      }}
    >
      {sortable ? (
        <button
          ref={setActivatorNodeRef}
          type="button"
          className={cn(
            "flex size-7 shrink-0 cursor-grab items-center justify-center border-0 bg-transparent text-muted-foreground",
            disabled && "cursor-not-allowed opacity-40",
          )}
          disabled={disabled}
          aria-label={`拖动排序 ${file.name}`}
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon />
        </button>
      ) : (
        <FileIcon className="shrink-0 text-lg text-muted-foreground" />
      )}

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground" title={file.name}>
          {file.name}
        </div>
        {file.size !== undefined ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {formatFileSize(file.size)}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {onPreview ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`预览 ${file.name}`}
                  onClick={() => onPreview(file)}
                />
              }
            >
              <EyeIcon />
            </TooltipTrigger>
            <TooltipContent>预览</TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`下载 ${file.name}`}
                render={
                  <a
                    href={resolveUrl(file.key)}
                    target="_blank"
                    download={file.name}
                  />
                }
              />
            }
          >
            <DownloadIcon />
          </TooltipTrigger>
          <TooltipContent>下载</TooltipContent>
        </Tooltip>
        {onRemove && !disabled ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-destructive hover:text-destructive"
                  aria-label={`删除 ${file.name}`}
                  onClick={() => onRemove(file)}
                />
              }
            >
              <Trash2Icon />
            </TooltipTrigger>
            <TooltipContent>删除</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

/** 可排序文件列表（@dnd-kit 拖拽排序 + 预览 / 下载 / 删除） */
export function SortableFileList({
  files,
  sortable = true,
  disabled = false,
  className,
  onChange,
  onPreview,
  onRemove,
}: SortableFileListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const previousIndex = files.findIndex((file) => file.key === active.id)
    const nextIndex = files.findIndex((file) => file.key === over.id)
    if (previousIndex < 0 || nextIndex < 0) return
    onChange?.(arrayMove(files, previousIndex, nextIndex))
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={files.map((file) => file.key)}
        strategy={verticalListSortingStrategy}
      >
        <div className={cn("border-y border-border", className)}>
          {files.map((file) => (
            <SortableFileItem
              key={file.key}
              file={file}
              sortable={sortable}
              disabled={disabled}
              onPreview={onPreview}
              onRemove={onRemove}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}
