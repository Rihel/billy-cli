export const Pages = {
  login: '/auth/login',
  dashboard: '/main/dashboard',
}
export const PublicPaths = [Pages.login]

// 管理员体系凭证 key：与前台（apps/web 的 access-token）分离，
// 避免同域（cookie 按域名共享 / 生产同域 localStorage 共享）下互相覆盖登录态
export const TokenKey = 'admin-access-token'
export const AppName = 'Billy Cli'
export const ServerUrl = process.env.SERVER_URL || 'http://localhost:9989'
process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:9989'

export const StorageUrl =
  process.env.NEXT_PUBLIC_STORAGE_URL || 'http://localhost:9000/billy-cli'

export const formatStorageUrl = (key: string) => {
  if (!key) return ''
  if (key.startsWith('http://') || key.startsWith('https://')) {
    return key
  }
  return `${StorageUrl}/${key}`
}
