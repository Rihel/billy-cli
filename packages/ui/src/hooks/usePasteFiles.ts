'use client'

import { useEventListener } from 'ahooks'

export const usePasteFiles = (
  onPaste: (files: File[], event: ClipboardEvent) => void | Promise<void>,
  enabled = true,
) => {
  useEventListener(
    'paste',
    (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length > 0) void onPaste(files, event)
    },
    {
      target: () => window,
      enable: enabled,
    },
  )
}
