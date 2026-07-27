import { AsyncLocalStorage } from 'async_hooks'

/** 模块级 AsyncLocalStorage 实例，service 和 decorator 共用 */
export const als = new AsyncLocalStorage<Record<string, any>>()
