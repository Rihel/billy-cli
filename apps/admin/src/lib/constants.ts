import { createAppUrlConfig } from '@repo/shared'

export const Pages = {
  login: '/auth/login',
  dashboard: '/main/dashboard',
}
export const PublicPaths = [Pages.login]

// 管理员体系凭证 key：与前台（apps/web 的 access-token）分离，
// 避免同域（cookie 按域名共享 / 生产同域 localStorage 共享）下互相覆盖登录态
export const TokenKey = 'admin-access-token'
export const AppName = 'Billy CLI'

/**
 * 主题模式的存储 key（同域部署时 localStorage 共享，前后台各用各的，避免互相改主题）。
 * 主题能力在 `@repo/ui` 的 `createTheme`，本常量在三处消费：store、layout 的防闪烁脚本。
 */
export const ThemeKey = 'billy-admin-theme'

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

/** 对象存储基地址 */
export const StorageUrl = urls.storageUrl

export const formatStorageUrl = urls.formatStorageUrl
