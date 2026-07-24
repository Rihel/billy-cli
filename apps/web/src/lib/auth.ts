import { TokenKey } from './constants'

export const authStorage = {
  getToken(): string | null {
    if (typeof window === 'undefined') return null
    return localStorage.getItem(TokenKey)
  },
  setToken(token: string): void {
    localStorage.setItem(TokenKey, token)
  },
  removeToken(): void {
    localStorage.removeItem(TokenKey)
  },
  isAuthenticated(): boolean {
    return !!authStorage.getToken()
  },
}
