'use client'

import { useCallback, useState } from 'react'

/**
 * 弹层开关状态（含可选附带数据），用于 Modal / Drawer / 详情等场景。
 * 基于 React 原生 useState 实现，零依赖。
 */
export const useDisclosure = <Data = void>(initialOpen = false) => {
  const [isOpen, setIsOpen] = useState(initialOpen)
  const [data, setData] = useState<Data | undefined>(undefined)

  const open = useCallback((nextData?: Data) => {
    setData(nextData)
    setIsOpen(true)
  }, [])

  const close = useCallback(() => setIsOpen(false), [])

  const toggle = useCallback(() => setIsOpen((open) => !open), [])

  const reset = useCallback(() => {
    setIsOpen(false)
    setData(undefined)
  }, [])

  return { isOpen, data, open, close, reset, toggle, setData }
}
