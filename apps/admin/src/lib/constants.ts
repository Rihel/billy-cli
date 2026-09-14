export const Pages = {
  login: '/auth/login',
  dashboard: '/main/dashboard',
}
export const PublicPaths = [Pages.login]

// 管理员体系凭证 key：与前台（apps/web 的 access-token）分离，
// 避免同域（cookie 按域名共享 / 生产同域 localStorage 共享）下互相覆盖登录态
export const TokenKey = 'admin-access-token'
export const AppName = 'Billy Cli'

/** 浏览器端 API 地址（`NEXT_PUBLIC_*` 在构建期内联，只有浏览器读得到） */
export const PublicServerUrl =
  process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:9989'

/**
 * 服务端（SSR / Server Actions）API 地址。
 *
 * `SERVER_URL` 是**运行时**环境变量（非 NEXT_PUBLIC，不会内联），容器里可指向内网地址
 * （compose 的 `SERVER_URL=http://server:9989`）；未配置时回落浏览器地址，本地开发零配置。
 */
export const ServerUrl = process.env.SERVER_URL || PublicServerUrl

export const StorageUrl =
  process.env.NEXT_PUBLIC_STORAGE_URL || 'http://localhost:9000/billy-cli'

export const formatStorageUrl = (key: string) => {
  if (!key) return ''
  if (key.startsWith('http://') || key.startsWith('https://')) {
    return key
  }
  return `${StorageUrl}/${key}`
}
