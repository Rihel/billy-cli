import * as React from 'react'
import { Input as InputPrimitive } from '@base-ui/react/input'

import { cn } from '#lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'h-8 w-full min-w-0 rounded-lg bg-surface-3 px-2.5 py-1 text-base ring-1 ring-inset ring-border transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-surface-2 file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-surface-1 disabled:opacity-50 aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-surface-2 dark:disabled:bg-surface-1 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
