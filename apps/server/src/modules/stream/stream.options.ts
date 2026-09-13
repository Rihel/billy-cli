/**
 * SSE 路由可配置项（由 StreamModule 以 SSE_ROUTE_OPTIONS 注入）。
 *
 * 抽成独立文件放 options / token，避免 controller 与 module 相互 import 形成循环依赖。
 */
export interface SseRouteOptions {
  /** 鉴权身份：'user'（前台用户，默认）| 'admin'（后台管理员） */
  auth?: 'user' | 'admin'
  /**
   * 业务频道白名单校验（如 task:42 / notification:all 等）。
   * 默认仅允许身份频道（user:* / admin:* 前缀由服务端强制替换为当前身份，业务频道一律拒绝）；
   * 业务方需要订阅自定义频道时在此注入校验（如数据库 / 缓存核对归属权）。
   */
  allowChannel?: (channel: string) => boolean
}

/** SSE 路由选项注入 token */
export const SSE_ROUTE_OPTIONS = Symbol.for('SseRouteOptions')
