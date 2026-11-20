import { describe, expect, it, vi } from 'vitest'
import { EnvelopeCipher, generateCredentialKey, type AppLogger } from '@repo/kits'
import {
  CredentialAuditAction,
  CredentialKind,
  CredentialLifetime,
  CredentialStatus,
  credentialAadOf,
  credentialHintOf,
  credentialTemplateOf,
  splitCredentialValues,
} from '@repo/shared'
import type { CredentialResolveRequest } from '@repo/contracts'
import type { PersonalCredentialEntity } from '@repo/db'
import { CredentialResolveService } from '../src/modules/ai-admin/credential/credential-resolve.service.js'
import {
  CredentialRefreshRegistry,
  CredentialRefreshRejectedError,
} from '../src/modules/ai-admin/credential/credential-refresh.js'
import type { PersonalCredentialRepository } from '../src/modules/ai-admin/credential/credential.repository.js'

/**
 * 解析与刷新（`docs/design/workspace-cli-credentials.md` §6.4.6）。
 *
 * 钉四件事：**提前量触发**（到期前 15 分钟才刷）、**按用户串行**（并发只刷一次）、
 * **失败分类**（确定性拒绝置 expired；网络故障不降级）、**每次读取/拒绝都留审计**（无凭据值）。
 */

const OWNER = { ownerType: 'user' as const, ownerId: 'u_1' }
const CIPHER_KEY = generateCredentialKey()

const cipherOf = () => new EnvelopeCipher({ keys: { v1: CIPHER_KEY }, current: 'v1' })

/** 构造一行已加密的凭据 */
const makeRow = (
  over: Partial<PersonalCredentialEntity> & Pick<PersonalCredentialEntity, 'id' | 'name'>,
): PersonalCredentialEntity => {
  const template = credentialTemplateOf('lark')!
  const { config, secret } = splitCredentialValues(template, {
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: 'x',
    scope: 'calendar',
  })
  const base = {
    ownerType: OWNER.ownerType,
    ownerId: OWNER.ownerId,
    provider: 'lark',
    kind: CredentialKind.Oauth,
    template: 'lark',
    lifetime: CredentialLifetime.Temporary,
    refresh: 'oauth',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    secretHint: credentialHintOf(template, config, secret),
    config,
    inject: [],
    status: CredentialStatus.Active,
    lastUsedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...over,
  } as PersonalCredentialEntity
  base.secretEnc = cipherOf().seal(secret, credentialAadOf(base))
  return base
}

const makeRepo = (rows: PersonalCredentialEntity[]) => {
  const repo = {
    rows,
    findById: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
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
    update: vi.fn(async (id: string, data: Partial<PersonalCredentialEntity>) => {
      const row = rows.find((item) => item.id === id)
      if (!row) return null
      Object.assign(row, data)
      return row
    }),
    touchLastUsed: vi.fn(async () => undefined),
  }
  return repo
}

const makeService = (rows: PersonalCredentialEntity[]) => {
  const repo = makeRepo(rows)
  const audit = { record: vi.fn(async () => undefined) }
  const registry = new CredentialRefreshRegistry()
  const sync = { push: vi.fn(async () => ({ pushed: 0, failed: 0, skipped: 0 })) }
  // 真串行锁的替身：按调用顺序串起来，才能验证"锁内二次查询只刷一次"
  let chain: Promise<unknown> = Promise.resolve()
  const locks = {
    withLock: vi.fn((_key: string, _ttl: number, _wait: number, fn: () => unknown) => {
      const run = chain.then(() => fn())
      chain = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }),
  }
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
  const service = new CredentialResolveService(
    repo as unknown as PersonalCredentialRepository,
    audit as never,
    { cipher: cipherOf(), internalToken: 'token' } as never,
    registry,
    sync as never,
    locks as never,
    logger,
  )
  return { service, repo, audit, registry, sync, locks, logger }
}

const request = (names: string[]): CredentialResolveRequest => ({
  ...OWNER,
  names,
  consumer: 'capability-gateway',
  requestId: 'req_1',
})

const auditActions = (audit: { record: ReturnType<typeof vi.fn> }): string[] =>
  audit.record.mock.calls.map((call) => (call[0] as { action: string }).action)

describe('解析：可用凭据直接解密返回', () => {
  it('长期凭据 → active + 明文 secret + resolve 审计 + 更新 last_used_at', async () => {
    const row = makeRow({
      id: 'c1',
      name: 'lark',
      kind: CredentialKind.Static,
      lifetime: CredentialLifetime.LongTerm,
      expiresAt: null,
    })
    const { service, repo, audit } = makeService([row])

    const response = await service.resolve(request(['lark']))

    expect(response.items[0]).toMatchObject({
      name: 'lark',
      status: 'active',
      secret: { accessToken: 'access-old' },
    })
    expect(repo.touchLastUsed).toHaveBeenCalledWith('c1')
    expect(auditActions(audit)).toEqual([CredentialAuditAction.Resolve])
    // 审计里不含凭据值
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('access-old')
  })

  it('缺失 / 已吊销 / 库中已失效 → 返回对应状态且不返回 secret，并落 deny 审计', async () => {
    const { service, audit } = makeService([
      makeRow({ id: 'c2', name: 'revoked', status: CredentialStatus.Revoked }),
      makeRow({ id: 'c3', name: 'expired', status: CredentialStatus.Expired }),
    ])

    const response = await service.resolve(request(['missing', 'revoked', 'expired']))

    expect(response.items.map((item) => item.status)).toEqual(['missing', 'revoked', 'expired'])
    expect(response.items.every((item) => item.secret === null)).toBe(true)
    expect(auditActions(audit)).toEqual([
      CredentialAuditAction.Deny,
      CredentialAuditAction.Deny,
      CredentialAuditAction.Deny,
    ])
  })

  it('status=active 但 expires_at 已过 → 按不可用处理（运行时以 expiresAt 为准）', async () => {
    const { service } = makeService([
      makeRow({
        id: 'c4',
        name: 'lark',
        kind: CredentialKind.Static,
        expiresAt: new Date(Date.now() - 1000),
      }),
    ])

    const response = await service.resolve(request(['lark']))

    expect(response.items[0].status).toBe('expired')
    expect(response.items[0].secret).toBeNull()
  })
})

describe('刷新：提前量触发 + 按用户串行 + 失败分类', () => {
  const larkTemplate = credentialTemplateOf('lark')!

  const makeAdapter = (over: { reject?: boolean; fail?: boolean } = {}) => {
    const refresh = vi.fn(async () => {
      if (over.reject) throw new CredentialRefreshRejectedError('lark', 'invalid_grant')
      if (over.fail) throw new Error('connect ECONNREFUSED')
      return {
        secret: { accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: 'y' },
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      }
    })
    return { provider: 'lark', refresh }
  }

  it('到期前 15 分钟内才刷新，刷新后写回新密文/新到期时间并落 refresh 审计', async () => {
    const nearExpiry = new Date(Date.now() + 5 * 60 * 1000)
    const row = makeRow({ id: 'c5', name: 'lark', expiresAt: nearExpiry })
    const { service, repo, audit, registry, locks } = makeService([row])
    const adapter = makeAdapter()
    registry.register(adapter)

    const beforeEnc = row.secretEnc
    const response = await service.resolve(request(['lark']))

    expect(adapter.refresh).toHaveBeenCalledTimes(1)
    expect(locks.withLock).toHaveBeenCalledWith(
      'credential:refresh:user:u_1',
      expect.any(Number),
      expect.any(Number),
      expect.any(Function),
    )
    expect(response.items[0].secret).toEqual({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiresAt: 'y',
    })
    expect(repo.rows[0].expiresAt!.getTime()).toBeGreaterThan(nearExpiry.getTime())
    expect(repo.rows[0].secretEnc).not.toBe(beforeEnc)
    expect(auditActions(audit)).toContain(CredentialAuditAction.Refresh)
    // 刷新后的提示值按模板重算
    expect(repo.rows[0].secretHint).toBe(
      credentialHintOf(larkTemplate, row.config, {
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
        expiresAt: 'y',
      }),
    )
  })

  it('距离到期还早 → 不刷新（不做无意义的上游调用）', async () => {
    const row = makeRow({ id: 'c6', name: 'lark' })
    const { service, registry } = makeService([row])
    const adapter = makeAdapter()
    registry.register(adapter)

    await service.resolve(request(['lark']))

    expect(adapter.refresh).not.toHaveBeenCalled()
  })

  it('并发两次解析：锁内二次查询让刷新只发生一次', async () => {
    const row = makeRow({ id: 'c7', name: 'lark', expiresAt: new Date(Date.now() + 60_000) })
    const { service, registry } = makeService([row])
    const adapter = makeAdapter()
    registry.register(adapter)

    const [first, second] = await Promise.all([
      service.resolve(request(['lark'])),
      service.resolve(request(['lark'])),
    ])

    expect(adapter.refresh).toHaveBeenCalledTimes(1)
    expect(first.items[0].secret).toEqual(second.items[0].secret)
  })

  it('确定性拒绝（invalid_grant）→ 置 expired，返回 expired，不返回 secret', async () => {
    const row = makeRow({ id: 'c8', name: 'lark', expiresAt: new Date(Date.now() + 60_000) })
    const { service, repo, audit, registry } = makeService([row])
    registry.register(makeAdapter({ reject: true }))

    const response = await service.resolve(request(['lark']))

    expect(response.items[0].status).toBe('expired')
    expect(response.items[0].secret).toBeNull()
    expect(repo.rows[0].status).toBe(CredentialStatus.Expired)
    expect(
      audit.record.mock.calls.some(
        (call) =>
          (call[0] as { action: string; detail?: { outcome?: string } }).action ===
            CredentialAuditAction.Refresh &&
          (call[0] as { detail?: { outcome?: string } }).detail?.outcome === 'rejected',
      ),
    ).toBe(true)
  })

  it('网络故障 → 不降级：凭据保持 active，仍返回原 secret（并记 transient 审计）', async () => {
    const row = makeRow({ id: 'c9', name: 'lark', expiresAt: new Date(Date.now() + 60_000) })
    const { service, repo, audit, registry } = makeService([row])
    registry.register(makeAdapter({ fail: true }))

    const response = await service.resolve(request(['lark']))

    expect(response.items[0].status).toBe('active')
    expect(response.items[0].secret).toEqual({
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
    })
    expect(repo.rows[0].status).toBe(CredentialStatus.Active)
    expect(
      audit.record.mock.calls.some(
        (call) => (call[0] as { detail?: { outcome?: string } }).detail?.outcome === 'transient',
      ),
    ).toBe(true)
  })

  it('没有适配器的 provider → 不刷新，按现状使用', async () => {
    const row = makeRow({
      id: 'c10',
      name: 'lark',
      provider: 'unknown-service',
      expiresAt: new Date(Date.now() + 60_000),
    })
    const { service, repo } = makeService([row])

    const response = await service.resolve(request(['lark']))

    expect(response.items[0].status).toBe('active')
    expect(repo.update).not.toHaveBeenCalled()
  })
})

describe('未配置主密钥', () => {
  it('解密能力不可用时明确报错（不返回空 secret）', async () => {
    const repo = makeRepo([])
    const locks = { withLock: vi.fn() }
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
    const service = new CredentialResolveService(
      repo as never,
      { record: vi.fn() } as never,
      { cipher: new EnvelopeCipher({ keys: {}, current: 'v1' }), internalToken: 'token' } as never,
      new CredentialRefreshRegistry(),
      { push: vi.fn() } as never,
      locks as never,
      logger,
    )

    await expect(service.resolve(request(['lark']))).rejects.toMatchObject({ code: 3404 })
  })
})
