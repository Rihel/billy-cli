"use client"

import type { ReactNode } from "react"

import { toast } from "#components/ui/toast"

/** 便捷方法：成功提示（标题 + 可选描述） */
export function toastSuccess(
  title: ReactNode,
  description?: ReactNode,
) {
  toast.add({ title, description, type: "success" })
}

/** 便捷方法：错误提示（标题 + 可选描述） */
export function toastError(
  title: ReactNode,
  description?: ReactNode,
) {
  toast.add({ title, description, type: "error" })
}

/** 便捷方法：警告提示（标题 + 可选描述） */
export function toastWarning(
  title: ReactNode,
  description?: ReactNode,
) {
  toast.add({ title, description, type: "warning" })
}

/** 便捷方法：信息提示（标题 + 可选描述） */
export function toastInfo(
  title: ReactNode,
  description?: ReactNode,
) {
  toast.add({ title, description, type: "info" })
}

/** 便捷方法：加载中提示（标题 + 可选描述），返回该 toast id，可用 toast.close(id) 关闭 */
export function toastLoading(
  title: ReactNode,
  description?: ReactNode,
) {
  return toast.add({ title, description, type: "loading", timeout: 0 })
}
