"use client"

import { useEffect } from "react"

/**
 * 监听全局粘贴事件，提取剪贴板文件（用于拖拽上传区的粘贴上传）。
 * 基于原生事件监听实现，零依赖。
 */
export const usePasteFiles = (
  onPaste: (files: File[], event: ClipboardEvent) => void | Promise<void>,
  enabled = true,
) => {
  useEffect(() => {
    if (!enabled) return

    const handlePaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length > 0) void onPaste(files, event)
    }

    window.addEventListener("paste", handlePaste)
    return () => window.removeEventListener("paste", handlePaste)
  }, [enabled, onPaste])
}
