export const Pages = {
  home: '/',
  login: '/auth/login',
  register: '/auth/register',
  forgotPassword: '/auth/forgot-password',
  resetPassword: '/auth/reset-password',
  markdown: '/markdown',
}

/** 首页锚点导航 */
export const LandingAnchors = {
  features: '#features',
  ai: '#ai',
  architecture: '#architecture',
  quickstart: '#quickstart',
}

export const TokenKey = 'access-token'
export const AppName = 'Billy CLI'
export const ServerUrl =
  process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:9989'

/** 对象存储（与 admin 同一套，用户头像等资源 key 拼接完整 URL） */
export const StorageUrl =
  process.env.NEXT_PUBLIC_STORAGE_URL || 'http://localhost:9000/billy-cli'

export const formatStorageUrl = (key: string) => {
  if (!key) return ''
  if (key.startsWith('http://') || key.startsWith('https://')) {
    return key
  }
  return `${StorageUrl}/${key}`
}

/** Admin 后台入口（开发环境 9845） */
export const AdminUrl = process.env.NEXT_PUBLIC_ADMIN_URL || 'http://localhost:9845'
