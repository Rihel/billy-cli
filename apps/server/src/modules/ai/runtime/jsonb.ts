import type { DeepPartial, QueryDeepPartialEntity } from 'typeorm'

/**
 * TypeORM 对 jsonb 列的 partial 更新类型过窄（`QueryDeepPartialEntity` 递归到 `unknown` 就判不可赋值），
 * 统一在这里收口一次：值本身是普通对象 / snake_case 字段，运行时没有问题。
 */
export const jsonbPatch = <T>(patch: DeepPartial<T>): QueryDeepPartialEntity<T> =>
  patch as QueryDeepPartialEntity<T>
