'use client'

import { InboxOutlined } from '@ant-design/icons'
import { App, Modal, Upload } from 'antd'
import type { UploadProps } from 'antd'
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { useImmer } from 'use-immer'
import { cn } from '../../lib/css'
import { usePasteFiles } from '../../hooks/usePasteFiles'
import { FilePreview } from './FilePreview'
import type { StorageFileValue } from './FilePreview'
import { SortableFileList } from './SortableFileList'
import { useStorage } from './useStorage'

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

  return accept.split(',').some((rule) => {
    const normalizedRule = rule.trim().toLowerCase()
    if (normalizedRule.startsWith('.')) return fileName.endsWith(normalizedRule)
    if (normalizedRule.endsWith('/*'))
      return fileType.startsWith(normalizedRule.slice(0, -1))
    return fileType === normalizedRule
  })
}

export const FileUpload = ({
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
}: FileUploadProps) => {
  const { message } = App.useApp()
  const valueRef = useRef(value)
  const pendingCountRef = useRef(0)
  const [previewFile, setPreviewFile] = useImmer<StorageFileValue | null>(null)
  valueRef.current = value

  const commit = async (files: StorageFileValue[]) => {
    valueRef.current = files
    await onChange?.(files)
  }

  const { customRequest: storageRequest, uploadFile } = useStorage({
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
      message.error(`不支持文件 ${file.name} 的格式`)
      return false
    }
    if (
      maxCount !== undefined &&
      valueRef.current.length + pendingCountRef.current >= maxCount
    ) {
      message.warning(`最多上传 ${maxCount} 个文件`)
      return false
    }
    return true
  }

  const uploadProps: UploadProps = {
    accept,
    multiple,
    disabled,
    showUploadList: false,
    beforeUpload(file) {
      if (!validateFile(file)) return Upload.LIST_IGNORE
      pendingCountRef.current += 1
      return true
    },
    async customRequest(options, info) {
      try {
        await storageRequest(options, info)
      } finally {
        pendingCountRef.current = Math.max(0, pendingCountRef.current - 1)
      }
    },
  }

  usePasteFiles(async (files) => {
    if (!paste || disabled) return
    const capacity = maxCount
      ? Math.max(0, maxCount - valueRef.current.length)
      : files.length
    const acceptedFiles = files
      .filter((file) => matchesAccept(file, accept))
      .slice(0, multiple ? capacity : 1)

    if (!acceptedFiles.length) {
      message.warning(accept ? '剪贴板中没有支持的文件' : '已达到文件数量上限')
      return
    }

    for (const file of acceptedFiles) {
      try {
        await uploadFile(file)
      } catch {
        // useStorage 已展示具体错误。
      }
    }
  }, paste && !disabled)

  const canUpload =
    !disabled && (maxCount === undefined || value.length < maxCount)

  return (
    <div className={cn('space-y-3', className)}>
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
        <Upload.Dragger {...uploadProps}>
          <div className="px-4 py-3">
            <InboxOutlined className="text-3xl text-gray-400" />
            <div className="mt-2 text-sm text-gray-700">
              点击或拖拽文件到此处上传
            </div>
            <div className="mt-1 text-xs text-gray-500">
              {tip ?? (
                <>
                  {paste ? '支持粘贴上传' : null}
                  {paste && sizeLimit ? '，' : null}
                  {sizeLimit ? `单个文件不超过 ${sizeLimit} MB` : null}
                </>
              )}
            </div>
          </div>
        </Upload.Dragger>
      ) : null}

      <Modal
        title={previewFile?.name}
        open={previewFile !== null}
        width="min(960px, calc(100vw - 32px))"
        footer={null}
        destroyOnHidden
        onCancel={() => setPreviewFile(null)}
      >
        {previewFile ? <FilePreview file={previewFile} /> : null}
      </Modal>
    </div>
  )
}
