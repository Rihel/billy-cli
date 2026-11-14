import { BadRequestException, type PipeTransform } from '@nestjs/common'
import type { ZodType } from 'zod'

/**
 * 统一把 `@Body()` 按契约 schema 校验/转换。
 *
 * 用 Nest 的 Pipe 而不是控制器里手写 safeParse：错误路径、类型收窄、校验位置都只有一处。
 */
export class ZodBodyPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value)
    if (!parsed.success) {
      throw new BadRequestException(
        `请求体不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
      )
    }
    return parsed.data
  }
}
