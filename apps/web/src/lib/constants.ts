export const Pages = {
  login: '/auth/login',
  register: '/auth/register',
  forgotPassword: '/auth/forgot-password',
  resetPassword: '/auth/reset-password',
  dashboard: '/main/dashboard',
}
export const PublicPaths = [
  Pages.login,
  Pages.register,
  Pages.forgotPassword,
  Pages.resetPassword,
]

export const TokenKey = 'access-token'
export const AppName = 'Billy Cli'

export const StorageUrl =
  process.env.NEXT_PUBLIC_STORAGE_URL || 'http://localhost:9000/billy-cli'

export const formatStorageUrl = (key: string) => {
  if (!key) return ''
  if (key.startsWith('http://') || key.startsWith('https://')) {
    return key
  }
  return `${StorageUrl}/${key}`
}
