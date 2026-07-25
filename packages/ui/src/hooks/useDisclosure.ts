'use client'

import { useState } from 'react'

export const useDisclosure = <Data = void>(initialOpen = false) => {
  const [isOpen, setIsOpen] = useState(initialOpen)
  const [data, setData] = useState<Data>()

  const open = (nextData?: Data) => {
    setData(nextData)
    setIsOpen(true)
  }

  const close = () => {
    setIsOpen(false)
  }

  const reset = () => {
    setIsOpen(false)
    setData(undefined)
  }

  return { isOpen, data, open, close, reset, setData }
}
