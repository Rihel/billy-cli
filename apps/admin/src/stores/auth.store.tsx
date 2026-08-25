'use client'

import { removeToken } from '@/lib/server-client'
import type { AdminModel } from '@repo/shared'
import { createContext, ReactNode, useContext, useState } from 'react'
import { createStore, StoreApi, useStore } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export type AuthStoreState = {
  adminInfo: AdminModel | null
}

export type AuthStoreActions = {
  setAdminInfo(data: Partial<AdminModel>): void
  clear(): void
}

export type AuthStore = AuthStoreState & AuthStoreActions

export const createAuthStore = (state: AuthStoreState) => {
  return createStore<AuthStore>()(
    immer((set) => ({
      ...state,
      clear() {
        removeToken()
        set((d) => {
          d.adminInfo = null
        })
      },
      setAdminInfo(data) {
        set((d) => {
          d.adminInfo = {
            ...d.adminInfo,
            ...(data as AdminModel),
          }
        })
      },
    })),
  )
}

const AuthStoreContext = createContext<StoreApi<AuthStore> | null>(null)

export type AuthStoreProviderProps = {
  children: ReactNode
  initialState: AuthStoreState
}

export function AuthStoreProvider({
  children,
  initialState,
}: AuthStoreProviderProps) {
  const [store] = useState(() => createAuthStore(initialState))
  return (
    <AuthStoreContext.Provider value={store}>
      {children}
    </AuthStoreContext.Provider>
  )
}

export function useAuthStore<T = AuthStore>(selector?: (s: AuthStore) => T): T {
  const store = useContext(AuthStoreContext)
  if (!store)
    throw new Error('useAuthStore must be used within AuthStoreProvider')
  return useStore(store, selector ?? ((s) => s as unknown as T))
}
