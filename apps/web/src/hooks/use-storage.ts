'use client'
import { useTRPCClient } from '@/lib/client-trpc'
import { FileInfo, getFileInfo, maybePromise } from '@repo/shared'
import { UploadProps } from 'antd'
import useApp from 'antd/es/app/useApp'
import { useImmer } from 'use-immer'

export type FileItem = {
  file: File
  key: string
  fileInfo: FileInfo | null
}

export type UseStorageOptions = {
  singleFile?: boolean
  /** 文件大小上限，单位 MB */
  sizeLimit?: number
  onChange?: (fileItems: FileItem[]) => void | Promise<void>
}

export const useStorage = (options: UseStorageOptions = {}) => {
  const trpcClient = useTRPCClient()

  const [fileItems, setFileItems] = useImmer<FileItem[]>([])
  const { message } = useApp()
  const customRequest: UploadProps['customRequest'] = async ({
    file,
    onError,
    onProgress,
    onSuccess,
  }) => {
    const uploadFile = file as File

    try {
      if (
        options.sizeLimit !== undefined &&
        uploadFile.size > options.sizeLimit * 1024 * 1024
      ) {
        throw new Error(`文件大小不能超过 ${options.sizeLimit} MB`)
      }

      const fileInfo = await getFileInfo(uploadFile)
      const key = `${fileInfo.md5}${fileInfo.ext ?? ''}`
      const presigned = await trpcClient.storage.getPresignedUrl.mutate({ key })

      onProgress?.({ percent: 0 })
      const response = await fetch(presigned.url, {
        method: 'PUT',
        body: uploadFile,
        headers: uploadFile.type
          ? { 'Content-Type': uploadFile.type }
          : undefined,
      })

      if (!response.ok) {
        throw new Error(`文件上传失败（HTTP ${response.status}）`)
      }

      const newFileItems = options.singleFile
        ? [{ file: uploadFile, fileInfo, key }]
        : [...fileItems, { file: uploadFile, fileInfo, key }]

      setFileItems(newFileItems)

      await maybePromise(options.onChange?.(newFileItems))
      onProgress?.({ percent: 100 })
      onSuccess?.({ key: presigned.key }, uploadFile)
    } catch (error) {
      const err = error instanceof Error ? error : new Error('文件上传失败')
      message.error(err.message)
      onError?.(err)
    }
  }
  const first = options.singleFile ? fileItems.at(0) : null

  return {
    customRequest,
    fileItems,
    first,
  }
}
