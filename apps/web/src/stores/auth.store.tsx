'use client'

import { authStorage } from '@/lib/auth'
import { UserModel } from '@repo/shared'
import { createContext, ReactNode, useContext, useState } from 'react'
import { z } from 'zod'
import { createStore, StoreApi, useStore } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export type AuthStoreState = {
  userInfo: z.infer<typeof UserModel> | null
}

export type AuthStoreActions = {
  setUserInfo(data: Partial<z.infer<typeof UserModel>>): void
  clear(): void
}

export type AuthStore = AuthStoreState & AuthStoreActions

export const createAuthStore = (state: AuthStoreState) => {
  return createStore<AuthStore>()(
    immer((set) => ({
      ...state,
      clear() {
        authStorage.removeToken()
        set((d) => {
          d.userInfo = null
        })
      },
      setUserInfo(data) {
        set((d) => {
          d.userInfo = {
            ...d.userInfo,
            ...(data as z.infer<typeof UserModel>),
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
