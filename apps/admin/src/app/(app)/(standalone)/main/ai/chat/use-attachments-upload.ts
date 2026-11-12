'use client'

import { useCallback, useRef, useState } from 'react'
import { getFileInfo } from '@repo/shared/browser'
import { useStorageAdapter } from '@repo/ui'

import { formatFileSize, rejectReasonOf, toAttachmentPayload } from './attachment-utils'
import { attachmentCapabilityIssue, type ChatAttachmentModel } from '@repo/shared'

/** 一个已上传到对象存储的附件 */
export interface UploadedAttachment {
  key: string
  file: File
}

/** 扫描待提交文件的结果：能收的、不能收的（带原因） */
export interface AttachmentScan {
  accepted: File[]
  rejected: string[]
}

/**
 * 扫描待提交的文件：**能收的与不能收的分开报**。
 *
 * 为什么不用 `PromptInput` 自带的校验：它的 `onError` 粒度是"这一批整体失败"（`max_file_size`
 * / `accept`），而用户粘 3 个文件时想知道的是**具体哪几个不行、为什么**。
 * 上限与类型清单与后端 `AgentChatSchema` 用同一个常量，不存在两套口径。
 */
export const scanFiles = (
  files: readonly File[],
  inputModalities?: readonly string[] | null,
): AttachmentScan => {
  const accepted: File[] = []
  const rejected: string[] = []
  for (const file of files) {
    const reason = rejectReasonOf(file) ?? modalityReasonOf(file, inputModalities)
    if (reason) rejected.push(reason)
    else accepted.push(file)
  }
  return { accepted, rejected }
}

/**
 * 这个文件当前模型读不读得了（能读返回 null）。
 *
 * **判据与服务端同一份**（`@repo/shared` 的 `attachmentCapabilityIssue`）：
 * 前端只说清"哪个文件不行、为什么"，服务端才是权威（前端可以绕过）。
 *
 * 三态里只有"明确声明不支持"才拦：
 * - `undefined`（清单还没到手）/ `null`（模型未声明模态）→ **放行**。
 *   国内厂商普遍不给模态信息，硬拦会把真正的视觉模型也误伤（用户粘了图却被告知不支持）。
 */
const modalityReasonOf = (
  file: File,
  inputModalities: readonly string[] | null | undefined,
): string | null => {
  const issue = attachmentCapabilityIssue(inputModalities, [
    { filename: file.name, mediaType: file.type },
  ])
  if (!issue || issue.code === 'undeclared') return null
  return issue.code === 'vision'
    ? `「${file.name}」是图片，但当前模型不支持图片输入（换一个支持图片的模型，或去掉它）`
    : `「${file.name}」是 PDF，但当前模型不支持文件输入（换一个支持文件的模型，或去掉它）`
}

export interface UseAttachmentsUploadResult {
  uploading: boolean
  /**
   * 上传并返回可提交的附件元数据（失败即抛错，调用方据此**不发送**这一轮）。
   *
   * 为什么先传后发：附件只以存储 key 进请求体（请求体与文件大小无关，绕开 2mb 上限）；
   * 传失败却把消息发出去，用户会看到一段"回复里对一个不存在的附件评头论足"的内容，
   * 那比直接报错难排查得多。
   */
  upload: (files: readonly File[]) => Promise<ChatAttachmentModel[]>
  /** 上传进度（已完成 / 总数），用于按钮旁的文案 */
  progress: { done: number; total: number }
}

/**
 * 对话附件上传：md5 key + 预签名直传对象存储（与 `useStorage` 同一套通道）。
 *
 * 为什么单独写一份而不直接用 `useStorage`：`useStorage` 是**表单控件那一路**（维护可见文件列表、
 * 单一文件模式、onChange 回调），而对话要的是"一次性把这一批传完、拿到 key 清单"，
 * 而且失败要抛给调用方去决定"发不发这一轮"（`useStorage` 内部吞掉错误只弹提示）。
 * 底层通道仍复用 `StorageClientProvider` 注入的同一个预签名接口，不另造一套。
 */
export const useAttachmentsUpload = (): UseAttachmentsUploadResult => {
  const { getPresignedUpload } = useStorageAdapter()
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  /** 用 ref 兜住最新值：并发提交时闭包拿到的不该是旧状态 */
  const uploadingRef = useRef(false)

  const upload = useCallback(
    async (files: readonly File[]): Promise<ChatAttachmentModel[]> => {
      if (files.length === 0) return []
      if (uploadingRef.current) {
        throw new Error('还有附件正在上传，请稍候')
      }

      uploadingRef.current = true
      setUploading(true)
      setProgress({ done: 0, total: files.length })
      try {
        const uploaded: UploadedAttachment[] = []
        for (const [index, file] of files.entries()) {
          // key 用内容 md5 + 后缀：同一张图重复上传天然去重（与 useStorage 的 key 口径一致）
          const fileInfo = await getFileInfo(file)
          const key = `${fileInfo.md5}${fileInfo.ext ?? ''}`
          const presigned = await getPresignedUpload(key)

          const response = await fetch(presigned.url, {
            method: 'PUT',
            body: file,
            headers: file.type ? { 'Content-Type': file.type } : undefined,
          })
          if (!response.ok) {
            throw new Error(`「${file.name}」上传失败（HTTP ${response.status}）`)
          }

          uploaded.push({ key: presigned.key, file })
          setProgress({ done: index + 1, total: files.length })
        }
        return toAttachmentPayload(uploaded)
      } finally {
        uploadingRef.current = false
        setUploading(false)
      }
    },
    [getPresignedUpload],
  )

  return { upload, uploading, progress }
}

/** 把被拒的文件整理成一句提示（最多列三个，其余折叠） */
export const rejectedText = (rejected: readonly string[]): string =>
  rejected.length <= 3
    ? rejected.join('；')
    : `${rejected.slice(0, 3).join('；')}；等 ${rejected.length} 个文件不符合要求`

/** 上传前的整体预检提示（给调用方拼文案用） */
export const describeLimit = (): string => `单个附件不超过 ${formatFileSize(2 * 1024 * 1024)}`
