import { describe, expect, it } from 'vitest'
import { AppErrorCodes } from '@repo/shared'
import { AppError } from '../src/foundation/errors/app-error.js'
import { mapError, messageOfDescriptor } from '../src/http/error/error-descriptor.js'

/**
 * 错误原因透出（issue B）：字典 label 只回答「哪一类失败」，
 * 带 detail 的错误必须把「这一次为什么失败」带到响应 message ——
 * 否则技能导入失败时界面永远只有一句「技能导入失败」，真实原因只在服务端日志里。
 */
class DemoError extends AppError {
  readonly code = AppErrorCodes.SkillImportFailed
  constructor(detail?: string) {
    super('技能导入失败：外部接口失败', detail)
  }
}

describe('mapError / messageOfDescriptor：detail 合进响应', () => {
  it('带 detail 的业务错误输出 label + 具体原因', () => {
    const descriptor = mapError(new DemoError('GitHub 接口限额已用尽'))
    expect(descriptor).toMatchObject({
      value: AppErrorCodes.SkillImportFailed,
      http: 400,
      label: '技能导入失败',
      detail: 'GitHub 接口限额已用尽',
    })
    expect(messageOfDescriptor(descriptor)).toBe('技能导入失败：GitHub 接口限额已用尽')
  })

  it('没有 detail 时只输出字典 label（既有响应形状不变）', () => {
    const descriptor = mapError(new DemoError())
    expect(descriptor.detail).toBeUndefined()
    expect(messageOfDescriptor(descriptor)).toBe('技能导入失败')
  })

  it('空白 detail 视为没给', () => {
    expect(mapError(new DemoError('   ')).detail).toBeUndefined()
  })
})
