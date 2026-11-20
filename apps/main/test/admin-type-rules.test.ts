import { describe, expect, it } from 'vitest'
import { AdminType, AppErrorCodes } from '@repo/shared'
import {
  assertAnotherAdminGod,
  assertCanChangeAdminType,
  assertCanCreateAdminType,
} from '../src/modules/admin/admin-type-rules.js'

/**
 * 管理员类型的权限规则（`docs/design/workspace-cli-credentials.md` §6.10 / C25 / C26）。
 *
 * 这些是安全不变量：普通管理员不能造超管 / 改类型，超管不能被降光或删光。
 * 纯函数直测，不连库。
 */

const normal = { adminType: AdminType.Normal }
const god = { adminType: AdminType.God }

describe('创建：只有超管（或系统调用）能造超管', () => {
  it('普通管理员造超管 → 2008 拒绝', () => {
    expect(() => assertCanCreateAdminType(normal, AdminType.God)).toThrow(
      expect.objectContaining({ code: AppErrorCodes.AdminTypeForbidden }),
    )
  })

  it('普通管理员建普通管理员、不传类型 → 放行', () => {
    expect(() => assertCanCreateAdminType(normal, undefined)).not.toThrow()
    expect(() => assertCanCreateAdminType(normal, AdminType.Normal)).not.toThrow()
  })

  it('超管造超管、系统调用（无 actor）造超管 → 放行', () => {
    expect(() => assertCanCreateAdminType(god, AdminType.God)).not.toThrow()
    expect(() => assertCanCreateAdminType(undefined, AdminType.God)).not.toThrow()
  })
})

describe('修改类型：谁能改 + 不能没有超管', () => {
  it('普通管理员改类型（含自我提权）→ 2008', () => {
    expect(() =>
      assertCanChangeAdminType({
        actor: normal,
        currentType: AdminType.Normal,
        nextType: AdminType.God,
        livingGods: 0,
      }),
    ).toThrow(expect.objectContaining({ code: AppErrorCodes.AdminTypeForbidden }))
  })

  it('降级最后一个超管 → 2009', () => {
    expect(() =>
      assertCanChangeAdminType({
        actor: god,
        currentType: AdminType.God,
        nextType: AdminType.Normal,
        livingGods: 1,
      }),
    ).toThrow(expect.objectContaining({ code: AppErrorCodes.LastGodAdminRequired }))
  })

  it('还有其他超管时可以降级；把普通管理员提成超管不查超管数', () => {
    expect(() =>
      assertCanChangeAdminType({
        actor: god,
        currentType: AdminType.God,
        nextType: AdminType.Normal,
        livingGods: 2,
      }),
    ).not.toThrow()
    expect(() =>
      assertCanChangeAdminType({
        actor: god,
        currentType: AdminType.Normal,
        nextType: AdminType.God,
        livingGods: 0,
      }),
    ).not.toThrow()
  })

  it('类型没变时直接放行（不因普通管理员而误拒）', () => {
    expect(() =>
      assertCanChangeAdminType({
        actor: normal,
        currentType: AdminType.Normal,
        nextType: AdminType.Normal,
        livingGods: 0,
      }),
    ).not.toThrow()
  })
})

describe('删除 / 降级：至少留一个超管', () => {
  it('只剩一个超管 → 2009；两个 → 放行', () => {
    expect(() => assertAnotherAdminGod(1)).toThrow(
      expect.objectContaining({ code: AppErrorCodes.LastGodAdminRequired }),
    )
    expect(() => assertAnotherAdminGod(2)).not.toThrow()
  })
})
