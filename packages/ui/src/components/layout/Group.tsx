'use client'

import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/css'

export type GroupProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  title?: ReactNode
  headerExtra?: ReactNode
  mark?: boolean
  bordered?: boolean
  headerClassName?: string
  headerExtraClassName?: string
  headerStyle?: CSSProperties
  contentClassName?: string
}

export const Group = ({
  title,
  headerExtra,
  mark = true,
  bordered = false,
  className,
  headerClassName,
  headerExtraClassName,
  headerStyle,
  contentClassName,
  children,
  ...props
}: GroupProps) => (
  <section
    {...props}
    className={cn(
      'w-full',
      bordered && 'border border-gray-200 p-4',
      className,
    )}
  >
    {title || headerExtra ? (
      <header
        className={cn(
          'mb-4 flex min-h-8 items-center justify-between gap-4',
          headerClassName,
        )}
        style={headerStyle}
      >
        <div
          className={cn(
            'text-base font-medium',
            mark && 'border-l-3 border-l-blue-500 pl-3 leading-5',
          )}
        >
          {title}
        </div>
        {headerExtra ? (
          <div className={cn('flex items-center gap-2', headerExtraClassName)}>
            {headerExtra}
          </div>
        ) : null}
      </header>
    ) : null}
    <div className={contentClassName}>{children}</div>
  </section>
)
