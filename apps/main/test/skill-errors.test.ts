import { describe, expect, it } from 'vitest'
import { AppErrorCodes } from '@repo/shared'
import { SkillImportFailedError } from '../src/modules/ai-admin/skill/skill.errors.js'

/**
 * 技能导入失败必须带 detail（issue B）：字典 label 只说「哪一类」，
 * 真实原因（GitHub 匿名限额 / 404 / 超时 / 没有 SKILL.md）只有 detail 能带出去。
 */
describe('SkillImportFailedError', () => {
  it('detail = 真实原因，message 保留「技能导入失败：」前缀', () => {
    const error = new SkillImportFailedError('GitHub 接口限额已用尽')
    expect(error.code).toBe(AppErrorCodes.SkillImportFailed)
    expect(error.detail).toBe('GitHub 接口限额已用尽')
    expect(error.message).toBe('技能导入失败：GitHub 接口限额已用尽')
  })
})
