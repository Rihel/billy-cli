'use client'

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export type LayoutStoreState = {
  isSiderCollapsed: boolean
}

export type LayoutStoreActions = {
  toggleSiderCollapsed(): void
}

export type LayoutStore = LayoutStoreState & LayoutStoreActions

export const useLayoutStore = create<LayoutStore>()(
  immer((set) => ({
    isSiderCollapsed: false,
    toggleSiderCollapsed() {
      set((state) => {
        state.isSiderCollapsed = !state.isSiderCollapsed
      })
    },
  })),
)
