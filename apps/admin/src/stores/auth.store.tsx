'use client'

import { getServerClient, removeToken } from '@/lib/server-client'
import type { AdminModel } from '@repo/shared'
import { createContext, ReactNode, useContext, useState } from 'react'
import { createStore, StoreApi, useStore } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export type AuthStoreState = {
  adminInfo: AdminModel | null
  /** 用户体系开关：false 时隐藏登录 / 用户管理相关 UI */
  authEnabled: boolean
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
        void removeToken()
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

export function AuthStoreProvider({ children, initialState }: AuthStoreProviderProps) {
  // 用户体系开关同步到业务请求所用的 server client 实例：
  // 关闭时该 client 的所有请求跳过前端凭证校验（等价 skipAuth），
  // 鉴权与否交由后端守卫判断。挂载时执行，早于任何业务请求。
  getServerClient().setAuthEnabled(initialState.authEnabled)
  const [store] = useState(() => createAuthStore(initialState))
  return <AuthStoreContext.Provider value={store}>{children}</AuthStoreContext.Provider>
}

export function useAuthStore<T = AuthStore>(selector?: (s: AuthStore) => T): T {
  const store = useContext(AuthStoreContext)
  if (!store) throw new Error('useAuthStore must be used within AuthStoreProvider')
  return useStore(store, selector ?? ((s) => s as unknown as T))
}
