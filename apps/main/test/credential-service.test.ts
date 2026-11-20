import { describe, expect, it, vi } from 'vitest'
import { requestContext, type AppLogger, EnvelopeCipher, generateCredentialKey } from '@repo/kits'
import { AppErrorCodes, CredentialStatus, type CredentialModel } from '@repo/shared'
import type { PersonalCredentialEntity } from '@repo/db'
import { PersonalCredentialService } from '../src/modules/ai-admin/credential/credential.service.js'
import type { PersonalCredentialRepository } from '../src/modules/ai-admin/credential/credential.repository.js'
import type { OwnerScope } from '../src/common/security/index.js'

/**
 * 凭据管理面（`docs/design/workspace-cli-credentials.md` §6.4 / §6.10.3）。
 *
 * 全部用内存假仓储 + **真的信封加密器**：要钉的是
 * "明文不落库 / AAD 防搬运 / 值不回显 / 归属不越权 / 覆盖需确认"。
 */

/** 内存版仓储（模拟软删与归属过滤，行为对齐真实 repository） */
const makeRepo = () => {
  const rows: PersonalCredentialEntity[] = []
  const alive = (scope: OwnerScope) =>
    rows.filter(
      (row) =>
        !row.deletedAt &&
        (scope.ownerType ? row.ownerType === scope.ownerType : true) &&
        (scope.ownerId ? row.ownerId === scope.ownerId : true),
    )

  const repo = {
    rows,
    findById: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
    listByScope: vi.fn(async (scope: OwnerScope) => alive(scope)),
    findByOwnerAndName: vi.fn(
      async (owner: { ownerType: string; ownerId: string }, name: string) =>
        rows.find(
          (row) =>
            !row.deletedAt &&
            row.ownerType === owner.ownerType &&
            row.ownerId === owner.ownerId &&
            row.name === name,
        ) ?? null,
    ),
    findActiveByOwnerAndProvider: vi.fn(async () => null),
    create: vi.fn(async (data: Partial<PersonalCredentialEntity>) => {
      const row = {
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        expiresAt: null,
        secretHint: null,
        config: {},
        inject: [],
        status: CredentialStatus.Active,
        lastUsedAt: null,
        ...data,
      } as unknown as PersonalCredentialEntity
      rows.push(row)
      return row
    }),
    update: vi.fn(async (id: string, data: Partial<PersonalCredentialEntity>) => {
      const row = rows.find((item) => item.id === id)
      if (!row) return null
      Object.assign(row, data, { updatedAt: new Date() })
      return row
    }),
    softDelete: vi.fn(async (id: string) => {
      const row = rows.find((item) => item.id === id)
      if (!row) return false
      row.deletedAt = new Date()
      return true
    }),
    touchLastUsed: vi.fn(async () => undefined),
  }
  return repo
}

const makeService = (options: { keys?: Record<string, string> } = {}) => {
  const repo = makeRepo()
  const cipher = new EnvelopeCipher({
    keys: options.keys ?? { v1: generateCredentialKey() },
    current: 'v1',
  })
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
  const audit = { record: vi.fn(async () => undefined) }
  const sync = { push: vi.fn(async () => ({ pushed: 0, failed: 0, skipped: 0 })) }
  const service = new PersonalCredentialService(
    repo as unknown as PersonalCredentialRepository,
    audit as never,
    sync as never,
    { cipher, internalToken: 'token' } as never,
    logger,
  )
  return { service, repo, cipher, audit }
}

/** 在某个身份下执行（真实实现从 ALS 读身份） */
const runAs = <T>(
  identity: { userId?: string; adminId?: string; adminType?: 'normal' | 'god' },
  fn: () => Promise<T>,
): Promise<T> =>
  requestContext.run(
    {
      requestId: 'test',
      userId: identity.userId ?? null,
      adminId: identity.adminId ?? null,
      ...(identity.adminType ? { adminType: identity.adminType } : {}),
    },
    fn,
  )

const MYSQL_VALUES = {
  host: '10.0.0.8',
  port: '3306',
  database: 'biz',
  username: 'root',
  password: 'S3cret!pass',
}

const bindMysql = (service: PersonalCredentialService, over: Record<string, unknown> = {}) =>
  service.bind({ provider: 'mysql', values: MYSQL_VALUES, ...over })

describe('绑定：明文不落库、值不回显', () => {
  it('密文里看不到密码，config 只有明文配置，提示取用户名', async () => {
    const { service, repo } = makeService()

    const model = await runAs({ userId: 'u_1' }, () => bindMysql(service))

    const row = repo.rows[0]
    expect(row.secretEnc.startsWith('v1:v1:')).toBe(true)
    expect(row.secretEnc).not.toContain('S3cret!pass')
    expect(JSON.stringify(row)).not.toContain('S3cret!pass')
    expect(row.config).toEqual({
      host: '10.0.0.8',
      port: 3306,
      database: 'biz',
      username: 'root',
    })
    expect(row.secretHint).toBe('root')
    // 对外模型没有密文字段
    expect(model).not.toHaveProperty('secretEnc')
    expect(JSON.stringify(model)).not.toContain('S3cret!pass')
  })

  it('模板默认注入规则随凭据入库（mysql → ~/.my.cnf）', async () => {
    const { service, repo } = makeService()
    await runAs({ userId: 'u_1' }, () => bindMysql(service))

    expect(repo.rows[0].inject).toEqual([
      expect.objectContaining({ type: 'file', path: '~/.my.cnf' }),
    ])
  })

  it('同名凭据已存在 → 3403（覆盖必须先确认，不做静默替换）', async () => {
    const { service } = makeService()
    await runAs({ userId: 'u_1' }, () => bindMysql(service))

    await expect(runAs({ userId: 'u_1' }, () => bindMysql(service))).rejects.toMatchObject({
      code: AppErrorCodes.CredentialNameTaken,
    })
  })

  it('模板不存在 → 3401；字段不合法 → 3402 且提示里不含字段值', async () => {
    const { service } = makeService()

    await expect(
      runAs({ userId: 'u_1' }, () => service.bind({ provider: 'no-such-cli', values: {} })),
    ).rejects.toMatchObject({ code: AppErrorCodes.CredentialTemplateNotFound })

    const failure = await runAs({ userId: 'u_1' }, () =>
      service.bind({ provider: 'mysql', values: { host: 'h', password: 'leak-me' } }),
    ).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: AppErrorCodes.CredentialInvalidInput })
    // 报错只带模板的中文提示，绝不回显字段值
    expect(String((failure as Error).message)).not.toContain('leak-me')
  })

  it('临时凭据必须填到期时间', async () => {
    const { service } = makeService()
    await expect(
      runAs({ userId: 'u_1' }, () => bindMysql(service, { lifetime: 'temporary' })),
    ).rejects.toMatchObject({ code: AppErrorCodes.CredentialInvalidInput })
  })

  it('未配置主密钥 → 3404，宁可不保存也不落明文', async () => {
    const { service, repo } = makeService({ keys: {} })
    await expect(runAs({ userId: 'u_1' }, () => bindMysql(service))).rejects.toMatchObject({
      code: AppErrorCodes.CredentialKeyNotConfigured,
    })
    expect(repo.rows).toHaveLength(0)
  })
})

describe('读取：列表只给元数据', () => {
  it('list 返回 config 与提示，不含密文', async () => {
    const { service } = makeService()
    await runAs({ userId: 'u_1' }, () => bindMysql(service))

    const list = await runAs({ userId: 'u_1' }, () => service.list({}))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ provider: 'mysql', name: 'mysql', secretHint: 'root' })
    expect(JSON.stringify(list)).not.toContain('secretEnc')
  })
})

describe('归属：越权与不存在同一个错误', () => {
  it('别人看不到、也取不到我的凭据', async () => {
    const { service } = makeService()
    const mine = await runAs({ userId: 'u_1' }, () => bindMysql(service))

    const otherList = await runAs({ userId: 'u_2' }, () => service.list({}))
    expect(otherList).toHaveLength(0)
    await expect(
      runAs({ userId: 'u_2' }, () => service.detail({ credentialId: mine.id })),
    ).rejects.toMatchObject({ code: AppErrorCodes.CredentialNotFound })
  })

  it('超管可见全部元数据（但模型里仍没有明文）', async () => {
    const { service } = makeService()
    await runAs({ userId: 'u_1' }, () => bindMysql(service))

    const all = await runAs({ adminId: 'god_1', adminType: 'god' }, () => service.list({}))
    expect(all).toHaveLength(1)
    expect(all[0].ownerId).toBe('u_1')
    expect(JSON.stringify(all)).not.toContain('S3cret!pass')
  })

  it('普通管理员只看到自己的（管理员存的是 admin 归属）', async () => {
    const { service } = makeService()
    await runAs({ userId: 'u_1' }, () => bindMysql(service))

    const adminList = await runAs({ adminId: 'adm_1', adminType: 'normal' }, () => service.list({}))
    expect(adminList).toHaveLength(0)
  })
})

describe('AAD：密文不能搬运到另一行', () => {
  it('把 A 行的密文换到 B 行 → 解不开', async () => {
    const { service, repo } = makeService()
    await runAs({ userId: 'u_1' }, () => bindMysql(service, { name: 'biz-a' }))
    await runAs({ userId: 'u_1' }, () =>
      service.bind({ provider: 'redis', name: 'cache-b', values: { host: 'cache' } }),
    )

    repo.rows[1].secretEnc = repo.rows[0].secretEnc
    await expect(service.reveal(repo.rows[1].id)).rejects.toBeTruthy()
  })

  it('正常解密拿得到原值（供内部消费方使用）', async () => {
    const { service, repo } = makeService()
    const model: CredentialModel = await runAs({ userId: 'u_1' }, () => bindMysql(service))

    const { secret } = await service.reveal(model.id)
    expect(secret).toEqual({ password: 'S3cret!pass' })
    expect(repo.rows[0].secretEnc).not.toContain('S3cret!pass')
  })
})

describe('吊销与改映射', () => {
  it('吊销置 revoked 并软删：列表看不到、名字可复用', async () => {
    const { service, repo } = makeService()
    const model = await runAs({ userId: 'u_1' }, () => bindMysql(service))

    await runAs({ userId: 'u_1' }, () => service.revoke({ credentialId: model.id }))

    expect(repo.rows[0].status).toBe(CredentialStatus.Revoked)
    expect(repo.rows[0].deletedAt).not.toBeNull()
    expect(await runAs({ userId: 'u_1' }, () => service.list({}))).toHaveLength(0)
    await expect(runAs({ userId: 'u_1' }, () => bindMysql(service))).resolves.toBeTruthy()
  })

  it('改映射只动 inject，不动凭据值', async () => {
    const { service, repo } = makeService()
    const model = await runAs({ userId: 'u_1' }, () => bindMysql(service))
    const before = repo.rows[0].secretEnc

    const updated = await runAs({ userId: 'u_1' }, () =>
      service.updateInject({
        credentialId: model.id,
        inject: [{ type: 'env', name: 'MYSQL_PWD', field: 'password' }],
      }),
    )

    expect(updated.inject).toEqual([{ type: 'env', name: 'MYSQL_PWD', field: 'password' }])
    expect(repo.rows[0].secretEnc).toBe(before)
  })

  it('别人的凭据不能吊销', async () => {
    const { service } = makeService()
    const model = await runAs({ userId: 'u_1' }, () => bindMysql(service))

    await expect(
      runAs({ userId: 'u_2' }, () => service.revoke({ credentialId: model.id })),
    ).rejects.toMatchObject({ code: AppErrorCodes.CredentialNotFound })
  })
})
