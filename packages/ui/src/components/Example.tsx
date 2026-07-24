'use client'

import { formatTime } from '@repo/shared'
import { useInterval } from 'ahooks'
import { useImmer } from 'use-immer'

export type ExampleProps = Partial<{}>

export const Example = ({}: ExampleProps) => {
  const [str, setStr] = useImmer('')
  useInterval(
    () => {
      setStr(formatTime())
    },
    1000,
    { immediate: true },
  )
  return <div className="bg-amber-50 text-shadow-md">{str}</div>
}
