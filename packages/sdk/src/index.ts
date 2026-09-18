export const packageName = '@repo/sdk'

/** 业务类型化 API 客户端（底层通用管线见 @repo/http-client） */
export { ServerClient } from './server.client.js'
export type { CreateStreamOptions } from './server.client.js'

/** 应用侧 HTTP 客户端装配（浏览器单例 / 服务端无状态客户端 / 凭证读写） */
export { createAppClients } from './app-clients.js'
export type { AppClients, AppClientsOptions } from './app-clients.js'
