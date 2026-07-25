'use client'

import { useStorage } from '@/hooks/use-storage'
import type { FileItem } from '@/hooks/use-storage'
import { formatStorageUrl } from '@/lib/constants'
import { PlusOutlined } from '@ant-design/icons'
import { cn } from '@repo/ui'
import { Button, Image, Upload } from 'antd'

export type ImageUploadProps = {
  value?: string | null
  sizeLimit?: number
  disabled?: boolean
  className?: string
  onChange?: (key: string, fileItem: FileItem) => void | Promise<void>
}

export const ImageUpload = ({
  value,
  sizeLimit,
  disabled,
  className,
  onChange,
}: ImageUploadProps) => {
  const { customRequest } = useStorage({
    singleFile: true,
    sizeLimit,
    async onChange(fileItems) {
      const fileItem = fileItems.at(0)
      if (fileItem) {
        await onChange?.(fileItem.key, fileItem)
      }
    },
  })

  const rootClassName = cn('w-40 h-40', className)
  const uploadProps = {
    accept: 'image/*',
    customRequest: customRequest,
    disabled: disabled,
    maxCount: 1,
    showUploadList: false,
  }
  if (value) {
    return (
      <div className="flex w-fit flex-col justify-center gap-2 items-center">
        <Image
          classNames={{
            root: rootClassName,
            image: 'object-cover !w-full !h-full',
          }}
          src={formatStorageUrl(value)}
        />
        <Upload {...uploadProps}>
          <Button type="link">重新选择</Button>
        </Upload>
      </div>
    )
  }
  return (
    <Upload {...uploadProps}>
      <div
        className={cn(
          rootClassName,
          'flex cursor-pointer items-center justify-center border border-dashed border-slate-200 bg-slate-100 hover:bg-slate-50',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <PlusOutlined className="text-3xl text-gray-300" />
      </div>
    </Upload>
  )
}
