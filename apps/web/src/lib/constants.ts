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

/** Admin 后台入口（开发环境 9845） */
export const AdminUrl = process.env.NEXT_PUBLIC_ADMIN_URL || 'http://localhost:9845'
