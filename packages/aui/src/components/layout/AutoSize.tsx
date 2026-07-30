'use client'

import type { CSSProperties, ReactNode } from 'react'
import { cn } from '../../lib/css'
import { useRect } from '../../hooks/useRect'
import type { ElementRect, UseRectOptions } from '../../hooks/useRect'

export type AutoSizeProps = {
  children: (rect: ElementRect) => ReactNode
  className?: string
  style?: CSSProperties
  rectOptions?: UseRectOptions
}

export const AutoSize = ({
  children,
  className,
  style,
  rectOptions,
}: AutoSizeProps) => {
  const { ref, rect } = useRect(rectOptions)

  return (
    <div ref={ref} className={cn('h-full w-full', className)} style={style}>
      {children(rect)}
    </div>
  )
}