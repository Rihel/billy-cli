'use client'

import { useEffect, useRef } from 'react'

export const useEventListener = <EventType extends Event>(
  target: EventTarget | null | undefined,
  type: string,
  listener: (event: EventType) => void,
  options?: AddEventListenerOptions | boolean,
  enabled = true,
) => {
  const listenerRef = useRef(listener)
  listenerRef.current = listener

  useEffect(() => {
    if (!target || !enabled) return
    const handler = (event: Event) => listenerRef.current(event as EventType)
    target.addEventListener(type, handler, options)
    return () => target.removeEventListener(type, handler, options)
  }, [target, type, options, enabled])
}
