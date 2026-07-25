'use client'

import type { ReactNode } from 'react'
import { cn } from '../../lib/css'
import { useRect } from '../../hooks/useRect'

export type PageToolbarProps = {
  title?: ReactNode
  extra?: ReactNode
  children?: ReactNode
  className?: string
}

export const PageToolbar = ({
  title,
  extra,
  children,
  className,
}: PageToolbarProps) => {
  const { ref, rect } = useRect()
  const compact = rect.width > 0 && rect.width < 640

  return (
    <div ref={ref} className={cn('mb-4', className)}>
      <div
        className={cn(
          'flex gap-4',
          compact ? 'flex-col items-stretch' : 'items-center justify-between',
        )}
      >
        {title ? <div className="text-base font-medium">{title}</div> : null}
        {extra ? (
          <div className="flex flex-wrap items-center gap-2">{extra}</div>
        ) : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  )
}
