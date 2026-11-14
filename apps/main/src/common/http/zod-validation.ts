import { StandardSchemaValidationPipe } from '@nestjs/common'
import { parseZodIssues } from '@repo/shared'
import type { ZodIssue } from 'zod'

/**
 * Zod 校验失败：走「HTTP 200 + code 400」的历史格式（前端 SDK 按 code 判错，
 * 与成功响应同为 200，便于统一拦截器处理；勿改成 HTTP 400）。
 */
export class ZodValidationFailedError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'ZodValidationFailedError'
  }
}

/**
 * 全局 Zod 校验管道（NestJS 12 原生 Standard Schema 能力，已替代自造装饰器 + 管道）。
 *
 * 用法：路由参数用原生选项声明 schema ——
 *
 *   @Post('create')
 *   @HttpCode(200)
 *   create(@Body({ schema: CreateUserSchema }) input: CreateUserDto) { ... }
 *
 * 管道从参数元数据（`ArgumentMetadata.schema`）读取 schema 并校验：
 * - 成功 → 返回解析后的值（含 Zod 默认值补全）；
 * - 失败 → 抛 ZodValidationFailedError，由 AppExceptionFilter 渲染为 HTTP 200 + code 400 + 中文文案；
 * - 未声明 schema 的参数与自定义装饰器（如 `@AccessToken()`）直通，故可安全注册为 `APP_PIPE` 全局管道。
 *
 * 注意：Zod 4 的 `~standard.validate` 原样透传 Zod issue（含 code / expected / minimum 等），
 * 因此 `parseZodIssues` 的字段级中文文案照常可用；若将来换成非 Zod 的 Standard Schema 库，
 * 该翻译需同步调整（Standard Schema 只保证 message / path）。
 */
export const createZodValidationPipe = (): StandardSchemaValidationPipe =>
  new StandardSchemaValidationPipe({
    exceptionFactory: (issues) =>
      new ZodValidationFailedError(parseZodIssues(issues as unknown as ZodIssue[])),
  })
