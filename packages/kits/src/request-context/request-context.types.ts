export type RequestContextOptions<T extends Record<string, any>> = {
  /** 根据请求初始化上下文 Store（req 是 IncomingMessage / Express Request） */
  defaultStoreFactory: (req: any) => T | Promise<T>
}

export const REQUEST_CONTEXT_OPTIONS = Symbol('REQUEST_CONTEXT_OPTIONS')

export type RequestContextAsyncOptions<T extends Record<string, any>> = {
  useFactory: (
    ...args: any[]
  ) => Promise<RequestContextOptions<T>> | RequestContextOptions<T>
  inject?: any[]
  imports?: any[]
}
