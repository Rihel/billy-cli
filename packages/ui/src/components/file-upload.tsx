"use client"

import { useRef, useState } from "react"
import type { DragEvent, ReactNode } from "react"

import { cn } from "#lib/utils"
import { Button } from "#components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "#components/ui/dialog"
import { FilePreview } from "#components/file-preview"
import type { StorageFileValue } from "#components/file-preview"
import { SortableFileList } from "#components/sortable-file-list"
import { toastError, toastWarning } from "#components/toast"
import { useStorage } from "#components/use-storage"
import { usePasteFiles } from "#hooks/use-paste-files"
import { UploadCloudIcon } from "lucide-react"

export type FileUploadProps = {
  value?: StorageFileValue[]
  accept?: string
  multiple?: boolean
  maxCount?: number
  sizeLimit?: number
  paste?: boolean
  sortable?: boolean
  preview?: boolean
  disabled?: boolean
  tip?: ReactNode
  className?: string
  onChange?: (files: StorageFileValue[]) => void | Promise<void>
}

const matchesAccept = (file: File, accept?: string) => {
  if (!accept) return true
  const fileName = file.name.toLowerCase()
  const fileType = file.type.toLowerCase()

  return accept.split(",").some((rule) => {
    const normalizedRule = rule.trim().toLowerCase()
    if (normalizedRule.startsWith(".")) return fileName.endsWith(normalizedRule)
    if (normalizedRule.endsWith("/*"))
      return fileType.startsWith(normalizedRule.slice(0, -1))
    return fileType === normalizedRule
  })
}

/** 文件上传：点击 / 拖拽 / 粘贴上传（原生实现 + 预签名直传），可选排序与预览 */
export function FileUpload({
  value = [],
  accept,
  multiple = true,
  maxCount,
  sizeLimit,
  paste = false,
  sortable = true,
  preview = true,
  disabled = false,
  tip,
  className,
  onChange,
}: FileUploadProps) {
  const valueRef = useRef(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const pendingCountRef = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [previewFile, setPreviewFile] = useState<StorageFileValue | null>(null)
  valueRef.current = value

  const commit = async (files: StorageFileValue[]) => {
    valueRef.current = files
    await onChange?.(files)
  }

  const { uploadFile } = useStorage({
    singleFile: !multiple,
    sizeLimit,
    async onChange(fileItems) {
      const uploadedFiles = fileItems.map(({ file, key }) => ({
        key,
        name: file.name,
        type: file.type || undefined,
        size: file.size,
      }))
      const nextFiles = multiple
        ? [...valueRef.current, ...uploadedFiles].filter(
            (file, index, files) =>
              files.findIndex((item) => item.key === file.key) === index,
          )
        : uploadedFiles.slice(-1)
      await commit(maxCount ? nextFiles.slice(0, maxCount) : nextFiles)
    },
  })

  const validateFile = (file: File) => {
    if (!matchesAccept(file, accept)) {
      toastError(`不支持文件 ${file.name} 的格式`)
      return false
    }
    if (
      maxCount !== undefined &&
      valueRef.current.length + pendingCountRef.current >= maxCount
    ) {
      toastWarning(`最多上传 ${maxCount} 个文件`)
      return false
    }
    return true
  }

  const handleFiles = async (files: File[]) => {
    if (disabled) return
    const capacity = maxCount
      ? Math.max(0, maxCount - valueRef.current.length)
      : files.length
    const acceptedFiles = files
      .filter((file) => matchesAccept(file, accept))
      .slice(0, multiple ? capacity : 1)

    if (!acceptedFiles.length) {
      toastWarning(accept ? "没有支持的文件" : "已达到文件数量上限")
      return
    }

    for (const file of acceptedFiles) {
      if (!validateFile(file)) continue
      pendingCountRef.current += 1
      try {
        await uploadFile(file)
      } finally {
        pendingCountRef.current = Math.max(0, pendingCountRef.current - 1)
      }
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    void handleFiles(Array.from(event.dataTransfer.files))
  }

  usePasteFiles(
    async (files) => {
      if (!paste || disabled) return
      void handleFiles(files)
    },
    paste && !disabled,
  )

  const canUpload =
    !disabled && (maxCount === undefined || value.length < maxCount)

  return (
    <div className={cn("space-y-3", className)}>
      {value.length ? (
        <SortableFileList
          files={value}
          sortable={multiple && sortable}
          disabled={disabled}
          onChange={(files) => void commit(files)}
          onPreview={preview ? setPreviewFile : undefined}
          onRemove={(file) =>
            void commit(
              valueRef.current.filter((item) => item.key !== file.key),
            )
          }
        />
      ) : null}

      {canUpload ? (
        <>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept={accept}
            multiple={multiple}
            disabled={disabled}
            onChange={(event) => {
              void handleFiles(Array.from(event.target.files ?? []))
              if (inputRef.current) inputRef.current.value = ""
            }}
          />
          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                inputRef.current?.click()
              }
            }}
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg bg-surface-1 px-4 py-6 text-center transition-colors hover:bg-muted",
              dragging && "bg-surface-3",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <UploadCloudIcon className="size-8 text-muted-foreground" />
            <div className="text-sm text-foreground">点击或拖拽文件到此处上传</div>
            <div className="text-xs text-muted-foreground">
              {tip ?? (
                <>
                  {paste ? "支持粘贴上传" : null}
                  {paste && sizeLimit ? "，" : null}
                  {sizeLimit ? `单个文件不超过 ${sizeLimit} MB` : null}
                </>
              )}
            </div>
          </div>
        </>
      ) : null}

      <Dialog
        open={previewFile !== null}
        onOpenChange={(next) => {
          if (!next) setPreviewFile(null)
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{previewFile?.name}</DialogTitle>
          </DialogHeader>
          {previewFile ? <FilePreview file={previewFile} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
