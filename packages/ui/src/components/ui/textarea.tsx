import * as React from 'react'

import { cn } from '#lib/utils.ts'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-lg bg-surface-3 px-2.5 py-2 text-base ring-1 ring-inset ring-border transition-colors outline-none placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-surface-1 disabled:opacity-50 aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-surface-2 dark:disabled:bg-surface-1 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
