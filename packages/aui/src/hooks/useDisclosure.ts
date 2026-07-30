'use client'

import { useBoolean } from 'ahooks'
import { useImmer } from 'use-immer'

export const useDisclosure = <Data = void>(initialOpen = false) => {
  const [isOpen, { setTrue, setFalse, toggle }] = useBoolean(initialOpen)
  const [data, setData] = useImmer<Data | undefined>(undefined)

  const open = (nextData?: Data) => {
    setData(nextData)
    setTrue()
  }

  const close = setFalse

  const reset = () => {
    setFalse()
    setData(undefined)
  }

  return { isOpen, data, open, close, reset, toggle, setData }
}
