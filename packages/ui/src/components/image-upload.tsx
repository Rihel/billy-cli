"use client"

import { useRef } from "react"

import { cn } from "#lib/utils"
import { Button } from "#components/ui/button"
import { ImagePlusIcon } from "lucide-react"
import { useStorageAdapter } from "#components/storage-provider"
import { useStorage } from "#components/use-storage"
import type { StorageFileItem } from "#components/use-storage"

export type ImageUploadProps = {
  value?: string | null
  sizeLimit?: number
  disabled?: boolean
  className?: string
  onChange?: (key: string, fileItem: StorageFileItem) => void | Promise<void>
}

/** 单图上传：预览 + 重新选择（原生 file input + 预签名直传） */
export function ImageUpload({
  value,
  sizeLimit,
  disabled,
  className,
  onChange,
}: ImageUploadProps) {
  const { resolveUrl } = useStorageAdapter()
  const inputRef = useRef<HTMLInputElement>(null)
  const { uploadFile } = useStorage({
    singleFile: true,
    sizeLimit,
    async onChange(fileItems) {
      const fileItem = fileItems.at(0)
      if (fileItem) {
        await onChange?.(fileItem.key, fileItem)
      }
    },
  })

  const handleFile = async (file?: File) => {
    if (!file || disabled) return
    await uploadFile(file)
    if (inputRef.current) inputRef.current.value = ""
  }

  const rootClassName = cn("size-40", className)

  return (
    <div className="flex w-fit flex-col items-center justify-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        disabled={disabled}
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />
      {value ? (
        <>
          <img
            src={resolveUrl(value)}
            alt="预览图"
            className={cn(
              rootClassName,
              "rounded-lg border border-border object-cover",
            )}
          />
          <Button
            variant="link"
            size="sm"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            重新选择
          </Button>
        </>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className={cn(
            rootClassName,
            "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-muted/50 text-muted-foreground transition-colors hover:bg-muted",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          <ImagePlusIcon className="size-8" />
          <span className="text-xs">点击上传图片</span>
        </button>
      )}
    </div>
  )
}
