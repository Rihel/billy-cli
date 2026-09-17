/**
 * SSE 路由可配置项（由 StreamModule 以 SSE_ROUTE_OPTIONS 注入）。
 *
 * 抽成独立文件放 options / token，避免 controller 与 module 相互 import 形成循环依赖。
 */
export interface SseRouteOptions {
  /**
   * 鉴权身份：
   * - `'user'`（默认）前台用户；
   * - `'admin'` 后台管理员；
   * - `'both'` 两者皆可 —— SSE 是**双端**能力（前台收用户通知、后台收告警广播），
   *   二选一模式会让另一半完全不可用。按实际通过的身份订阅对应频道。
   */
  auth?: 'user' | 'admin' | 'both'
  /**
   * 广播频道：在身份频道之外**自动订阅**的频道（如 `admin:all`）。
   *
   * 为什么必须由服务端注入：客户端请求里的 `user:*` / `admin:*` 一律被忽略（防窃听他人
   * 身份频道），所以广播频道没有别的入口。安全约束：**只放行与当前身份同域的频道**
   * （管理员只拿得到 `admin:` 前缀、用户只拿得到 `user:` 前缀），跨域项静默忽略。
   */
  broadcastChannels?: string[]
  /**
   * 业务频道白名单校验（如 task:42 / notification:all 等）。
   * 默认仅允许身份频道（user:* / admin:* 前缀由服务端强制替换为当前身份，业务频道一律拒绝）；
   * 业务方需要订阅自定义频道时在此注入校验（如数据库 / 缓存核对归属权）。
   */
  allowChannel?: (channel: string) => boolean
}

/** SSE 路由选项注入 token */
export const SSE_ROUTE_OPTIONS = Symbol.for('SseRouteOptions')
