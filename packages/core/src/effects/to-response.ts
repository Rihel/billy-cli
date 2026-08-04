import { Effect } from 'effect'
import { ResponseUtils, type AppResponse } from '@repo/shared'
import type { AppError } from '../errors.js'

/** 将 Effect<T, AppError> 转为 Effect<AppResponse<T>, never>，错误进入响应体 */
export function toResponse<T>(
  effect: Effect.Effect<T, AppError>,
): Effect.Effect<AppResponse<T>, never> {
  return effect.pipe(
    Effect.map((data) => ResponseUtils.success(data)),
    Effect.catchAll((e) =>
      Effect.succeed(ResponseUtils.error<T>(e.code, e.message)),
    ),
  )
}
