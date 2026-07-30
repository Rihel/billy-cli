'use client'

import { Flex, Spin } from 'antd'
import type { SpinProps } from 'antd'
import type { ReactNode } from 'react'
import { cn } from '../../lib/css'

export type PageLoadingProps = {
  tip?: ReactNode
  fullscreen?: boolean
  className?: string
  spinProps?: Omit<SpinProps, 'tip' | 'fullscreen'>
}

export const PageLoading = ({
  tip,
  fullscreen = false,
  className,
  spinProps,
}: PageLoadingProps) => (
  <Flex
    vertical
    align="center"
    justify="center"
    gap="small"
    className={cn(fullscreen ? 'min-h-screen' : 'min-h-64', className)}
  >
    <Spin {...spinProps} size={spinProps?.size ?? 'large'} />
    {tip ? <div className="text-sm text-gray-500">{tip}</div> : null}
  </Flex>
)
