import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BasePaginateSchema } from '../src/schema/base.schema'
import { parseZodIssues } from '../src/utils/zod.utils'

/** 把 safeParse 的失败转成接口里会看到的那句中文 */
const messageOf = (schema: z.ZodType, value: unknown): string => {
  const result = schema.safeParse(value)
  if (result.success) throw new Error('期望校验失败，实际通过了')
  return parseZodIssues(result.error.issues)
}

describe('parseZodIssues', () => {
  it('数字上限不说「个字符」：分页 size 超限是条数问题，不是输入长度', () => {
    expect(messageOf(BasePaginateSchema, { page: 1, size: 200 })).toBe('每页条数不能超过100')
  })

  it('数字下限同样按数值表达', () => {
    expect(messageOf(BasePaginateSchema, { page: 0, size: 10 })).toBe('页码不能小于1')
  })

  it('字符串上限仍然说「个字符」', () => {
    expect(messageOf(z.object({ name: z.string().max(4) }), { name: 'abcdef' })).toBe(
      '名称不能超过4个字符',
    )
  })

  it('数组条数说「项」', () => {
    expect(
      messageOf(z.object({ tags: z.array(z.string()).max(2) }), { tags: ['a', 'b', 'c'] }),
    ).toBe('tags最多 2 项')
  })
})
