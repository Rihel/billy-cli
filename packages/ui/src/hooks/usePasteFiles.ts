'use client'

import { useEffect, useState } from 'react'
import { useEventListener } from './useEventListener'

export const usePasteFiles = (
  onPaste: (files: File[], event: ClipboardEvent) => void | Promise<void>,
  enabled = true,
) => {
  const [target, setTarget] = useState<Window | null>(null)

  useEffect(() => setTarget(window), [])

  useEventListener<ClipboardEvent>(
    target,
    'paste',
    (event) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length > 0) void onPaste(files, event)
    },
    undefined,
    enabled,
  )
}
