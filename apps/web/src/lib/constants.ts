import { createAppUrlConfig } from '@repo/shared'

export const Pages = {
  home: '/',
  login: '/auth/login',
  register: '/auth/register',
  forgotPassword: '/auth/forgot-password',
  resetPassword: '/auth/reset-password',
  /** 受保护的用户区（未登录访问会跳登录页并带 `?next=` 回跳） */
  account: '/account',
  /** AI 会话页（同样受保护：AI 会话按用户归属，未登录没有会话） */
  aiChat: '/ai/chat',
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

/**
 * 主题模式的存储 key（同域部署时 localStorage 共享，前后台各用各的，避免互相改主题）。
 * 主题能力在 `@repo/ui` 的 `createTheme`，本常量在 store 与 layout 的防闪烁脚本里消费。
 */
export const ThemeKey = 'billy-theme'

/**
 * 地址解析：机制（回落顺序 / key 拼接）在 `@repo/shared`，**环境变量的读取留在 app** ——
 * `NEXT_PUBLIC_*` 由 Next 在构建期替换，搬进包里就不再替换（本地正常、容器里回落 localhost）。
 *
 * `SERVER_URL` 是**运行时**环境变量（非 NEXT_PUBLIC，不会内联），容器里可指向内网地址
 * （compose 的 `SERVER_URL=http://server:9989`）；未配置时回落公开地址，本地开发零配置。
 */
const urls = createAppUrlConfig({
  publicServerUrl: process.env.NEXT_PUBLIC_SERVER_URL,
  runtimeServerUrl: process.env.SERVER_URL,
  storageUrl: process.env.NEXT_PUBLIC_STORAGE_URL,
})

/** 浏览器端 API 地址 */
export const PublicServerUrl = urls.publicServerUrl

/** 服务端（SSR / Server Actions）API 地址 */
export const ServerUrl = urls.serverUrl

/** 对象存储基地址（用户头像等资源 key 拼接完整 URL） */
export const StorageUrl = urls.storageUrl

export const formatStorageUrl = urls.formatStorageUrl

/** Admin 后台入口（开发环境 9845） */
export const AdminUrl = process.env.NEXT_PUBLIC_ADMIN_URL || 'http://localhost:9845'
