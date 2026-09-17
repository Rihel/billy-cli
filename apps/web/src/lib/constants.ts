export const Pages = {
  home: '/',
  login: '/auth/login',
  register: '/auth/register',
  forgotPassword: '/auth/forgot-password',
  resetPassword: '/auth/reset-password',
  /** 受保护的用户区（未登录访问会跳登录页并带 `?next=` 回跳） */
  account: '/account',
  markdown: '/markdown',
}

/** 首页锚点导航 */
export const LandingAnchors = {
  why: '#why',
  features: '#features',
  choice: '#choice',
  ai: '#ai',
  architecture: '#architecture',
  quickstart: '#quickstart',
}

export const TokenKey = 'access-token'
export const AppName = 'Billy CLI'

/** 浏览器端 API 地址（`NEXT_PUBLIC_*` 在构建期内联，只有浏览器读得到） */
export const PublicServerUrl =
  process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:9989'

/**
 * 服务端（SSR / Server Actions）API 地址。
 *
 * `SERVER_URL` 是**运行时**环境变量（非 NEXT_PUBLIC，不会内联），所以容器里可以指向内网地址
 * （compose 的 `SERVER_URL=http://server:9989`）；未配置时回落浏览器地址，本地开发零配置。
 * 与 admin（`apps/admin/src/lib/constants.ts`）同一套约定。
 */
export const ServerUrl = process.env.SERVER_URL || PublicServerUrl

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
