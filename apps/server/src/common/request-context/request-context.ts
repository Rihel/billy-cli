import { AsyncLocalStorage } from 'node:async_hooks'

/** 请求上下文数据：贯穿中间件 → 守卫 → 控制器 → service 的隐式传递通道 */
export interface RequestContextData {
  /** 每请求唯一 id（响应头 X-Request-Id 同值，用于日志 / 告警排障） */
  requestId: string
  /** 当前登录用户 id（前台用户体系；未登录为 null） */
  userId: string | null
  /** 当前登录管理员 id（后台管理体系；未登录为 null） */
  adminId: string | null
  /**
   * 客户端 IP（登录设备列表的会话元数据用；取不到为 null）。
   * 可选：历史上构造过上下文的地方（如单测）不必补这两个字段。
   */
  ip?: string | null
  /** User-Agent（同上，登录设备识别用） */
  userAgent?: string | null
}

const storage = new AsyncLocalStorage<RequestContextData>()

/**
 * 请求上下文（AsyncLocalStorage 实现）：在守卫中写入身份，在 service / repository 中读取，
 * 避免把 userId 一路透传到业务方法签名。
 */
export const requestContext = {
  run<Result>(store: RequestContextData, callback: () => Result): Result {
    return storage.run(store, callback)
  },
  getStore(): RequestContextData | undefined {
    return storage.getStore()
  },
  get<Key extends keyof RequestContextData>(key: Key): RequestContextData[Key] | undefined {
    return storage.getStore()?.[key]
  },
  set<Key extends keyof RequestContextData>(key: Key, value: RequestContextData[Key]): void {
    const store = storage.getStore()
    if (store) store[key] = value
  },
}
