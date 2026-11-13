'use client'

import * as React from 'react'

import { cn } from '#lib/utils'

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    // 关联由使用方通过 htmlFor 或包裹控件提供，这里只是样式原语
    // oxlint-disable-next-line jsx-a11y/label-has-associated-control
    <label
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Label }
