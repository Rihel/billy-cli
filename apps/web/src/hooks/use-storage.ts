'use client'
import { useTRPCClient } from '@/lib/client-trpc'
import { FileInfo, getFileInfo } from '@repo/shared'
import { UploadProps } from 'antd'
import { useImmer } from 'use-immer'

export type FileItem = {
  file: File
  fileInfo: FileInfo | null
}

export type UseStorageOptions = {
  singleFile?: boolean
}

export const useStorage = (options: UseStorageOptions = {}) => {
  const trpcClient = useTRPCClient()

  const [fileItems, setFileItems] = useImmer<FileItem[]>([])
  const customRequest: UploadProps['customRequest'] = async ({
    file,
    onError,
    onProgress,
    onSuccess,
  }) => {
    const uploadFile = file as File

    try {
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

      setFileItems((draft) => {
        const item = { file: uploadFile, fileInfo }
        if (options.singleFile) {
          draft.splice(0, draft.length, item)
        } else {
          draft.push(item)
        }
      })
      onProgress?.({ percent: 100 })
      onSuccess?.({ key: presigned.key }, uploadFile)
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error('文件上传失败'))
    }
  }

  return {
    customRequest,
    fileItems,
  }
}
