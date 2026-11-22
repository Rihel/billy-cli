import { describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '@repo/kits'
import type { WorkspaceSetupPackage } from '@repo/shared'
import { WorkspaceSetupService } from '../src/workspace/setup/setup.service.js'
import type { SetupExecResult, SetupShell } from '../src/workspace/setup/shell.js'
import type { WorkspaceRepository } from '../src/workspace/workspace.repository.js'
import type { WorkspaceCredentialClient } from '../src/workspace/credential/client.js'

/**
 * 初始化阶段编排（`docs/design/workspace-cli-credentials.md` §6.3）。
 *
 * 用假 shell / 假仓储 / 假凭据客户端，钉的是**顺序与幂等**：
 * ① 安装（verify 未过才装）→ ② 物化技能 → ③ 落地凭据 → ④ 版本文件；
 * 单项失败只进 `setup_report`，不抛。
 */

/** 容器形态的环境声明：能装包、能写 HOME（Host 的声明见 features.test.ts） */
const CONTAINER_FEATURES = {
  shell: 'sh',
  sandbox: 'none',
  network: 'allow',
  writeHome: true,
  installGlobal: true,
  persistence: 'ephemeral',
  resourceLimits: true,
  extraReadRoots: false,
  multiInstance: false,
} as const

const ok = (stdout = ''): SetupExecResult => ({ ok: true, code: 0, stdout, stderr: '' })
const fail = (stderr = 'boom'): SetupExecResult => ({ ok: false, code: 1, stdout: '', stderr })

const PACKAGE: WorkspaceSetupPackage = {
  manager: 'npm',
  spec: 'lark-cli@1.2.3',
  verify: 'lark --version',
}

const makeShell = (options: { marker?: string | null; verifyFirst?: boolean } = {}) => {
  const execs: string[] = []
  const writes: { path: string; content: string; mode?: number }[] = []
  let verifyCalls = 0
  const shell: SetupShell = {
    async exec(command) {
      execs.push(command)
      if (command === PACKAGE.verify) {
        verifyCalls += 1
        // 第一次 verify 失败（没装），装完后的第二次成功
        return verifyCalls === 1 && !options.verifyFirst ? fail('command not found') : ok('1.2.3')
      }
      if (command.startsWith('npm install')) return ok()
      return ok()
    },
    async write(path, content, mode) {
      writes.push({ path, content, mode })
    },
    async read(path) {
      if (path.includes('.done')) return options.marker ?? null
      return null
    },
    async listDirs() {
      return []
    },
  }
  return { shell, execs, writes }
}

const makeService = (
  over: {
    marker?: string | null
    packages?: WorkspaceSetupPackage[]
    skills?: { key: string; files: { path: string; content: string }[] }[]
    credentialNames?: string[]
    resolve?: () => Promise<unknown>
  } = {},
) => {
  const repo = {
    findSetupContext: vi.fn(async () => ({
      ownerType: 'user' as const,
      ownerId: 'u_1',
      setupId: null,
      setupExtra: [] as unknown[],
    })),
    findSetupById: vi.fn(async () => null),
    findDefaultSetup: vi.fn(async () => ({
      id: 'setup_1',
      packages: over.packages ?? [PACKAGE],
      files: [],
      env: { FOO: 'bar' },
    })),
    listVisibleSkills: vi.fn(
      async () =>
        over.skills ?? [
          {
            key: 'demo',
            name: 'demo',
            description: 'd',
            files: [{ path: 'SKILL.md', content: '# demo' }],
          },
        ],
    ),
    listActiveCredentialNames: vi.fn(async () => over.credentialNames ?? ['mysql']),
    listActiveCredentialVersions: vi.fn(async () => [{ version: 3 }]),
  }
  const credentials = {
    resolve: vi.fn(
      over.resolve ??
        (async () => [
          {
            name: 'mysql',
            provider: 'mysql',
            status: 'active',
            expiresAt: null,
            config: { host: 'db', port: 3306, database: 'biz', username: 'root' },
            secret: { password: 'p@ss' },
            inject: [
              {
                type: 'file',
                path: '~/.my.cnf',
                template: 'password=${secret.password}\n',
              },
              { type: 'env', name: 'MYSQL_PWD', field: 'password' },
            ],
          },
        ]),
    ),
  }
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  } as unknown as AppLogger
  const service = new WorkspaceSetupService(
    repo as unknown as WorkspaceRepository,
    credentials as unknown as WorkspaceCredentialClient,
    { mainUrl: 'http://main', internalToken: 't' } as never,
    logger,
  )
  return { service, repo, credentials, logger }
}

describe('首次初始化：按固定顺序走完四步', () => {
  it('装包 → 物化技能 → 落地凭据（文件 600 / env）→ 写版本与清单', async () => {
    const { service } = makeService()
    const { shell, execs, writes } = makeShell()

    const { env, report, resolved } = await service.run('ws_1', shell, CONTAINER_FEATURES)

    // 凭据段整体解析成功：调用方据此把 credentialsReady 标 true
    expect(resolved).toBe(true)
    // ① 先 verify（失败）→ 安装 → 再 verify（成功）
    expect(execs[0]).toBe('lark --version')
    expect(execs[1]).toContain('npm install -g --no-fund --no-audit lark-cli@1.2.3')
    expect(report.packages).toEqual([{ spec: 'lark-cli@1.2.3', outcome: 'installed' }])
    // ② 技能写到 .agents/<key>/
    expect(writes.some((item) => item.path === '.agents/demo/SKILL.md')).toBe(true)
    // ③ 凭据文件 600 + env 返回
    const credentialFile = writes.find((item) => item.path === '~/.my.cnf')
    expect(credentialFile).toMatchObject({ content: 'password=p@ss\n', mode: 600 })
    expect(env).toEqual({ FOO: 'bar', MYSQL_PWD: 'p@ss' })
    // ④ 版本 / 清单 / 幂等标记
    expect(writes.some((item) => item.path === '.billy/setup.json')).toBe(true)
    const manifest = writes.find((item) => item.path === '.billy/credentials.json')
    expect(JSON.parse(manifest!.content)).toMatchObject({
      items: [{ provider: 'mysql', name: 'mysql', expiresAt: null }],
    })
    expect(
      writes.some((item) => item.path.startsWith('.billy/setup/') && item.path.endsWith('.done')),
    ).toBe(true)
    expect(report.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('幂等：标记命中不重装', () => {
  it('已有 done 标记 → 不再 verify / 安装 / 写技能，但凭据仍然重新落地', async () => {
    const { service, credentials } = makeService()
    const { shell, execs, writes } = makeShell({ marker: 'done' })

    const { env, report } = await service.run('ws_1', shell, CONTAINER_FEATURES)

    expect(execs).toEqual([])
    expect(report.packages).toEqual([])
    expect(writes.some((item) => item.path.startsWith('.agents/'))).toBe(false)
    // 凭据仍重新解析并写入（便宜且保证与库一致）
    expect(credentials.resolve).toHaveBeenCalledWith({
      ownerType: 'user',
      ownerId: 'u_1',
      names: ['mysql'],
    })
    expect(env.MYSQL_PWD).toBe('p@ss')
  })

  it('依赖缓存命中（verify 直接通过）→ 记为 skipped，不执行安装', async () => {
    const { service } = makeService()
    const { shell, execs } = makeShell({ verifyFirst: true })

    const { report } = await service.run('ws_1', shell, CONTAINER_FEATURES)

    expect(execs.filter((command) => command.startsWith('npm install'))).toEqual([])
    expect(report.packages).toEqual([{ spec: 'lark-cli@1.2.3', outcome: 'skipped' }])
  })
})

describe('Host 环境（按声明降级）', () => {
  const HOST_FEATURES = {
    ...CONTAINER_FEATURES,
    // 开沙箱的 Host：写不了 HOME、装不了全局包
    sandbox: 'os',
    network: 'deny',
    writeHome: false,
    installGlobal: false,
    persistence: 'durable',
    resourceLimits: false,
  } as const

  it('只物化技能：不装包、不写凭据清单，凭据客户端也不调', async () => {
    const { service, credentials } = makeService()
    const { shell, execs, writes } = makeShell()

    const { manifest, resolved } = await service.run('ws_1', shell, HOST_FEATURES)

    expect(execs.some((command) => command.startsWith('npm install'))).toBe(false)
    expect(credentials.resolve).not.toHaveBeenCalled()
    expect(writes.some((item) => item.path.startsWith('.agents/'))).toBe(true)
    expect(writes.some((item) => item.path.endsWith('.billy/credentials.json'))).toBe(false)
    expect(manifest).toEqual([])
    // 跳过凭据不是失败：不触发补偿重试
    expect(resolved).toBe(true)
  })
})

describe('P9 技能收敛：写可见、删不可见目录', () => {
  it('不可见的旧目录被删除，可见的重新写入', async () => {
    const { service } = makeService({
      skills: [{ key: 'keep', files: [{ path: 'SKILL.md', content: '# keep' }] }],
    })
    const execs: string[] = []
    const writes: string[] = []
    const shell = {
      async exec(command: string) {
        execs.push(command)
        return { ok: true, code: 0, stdout: '', stderr: '' }
      },
      async write(path: string) {
        writes.push(path)
      },
      async read(path: string) {
        // 只有「我们写过的」目录带标记；没标记的不动
        return path === '.agents/stale/.billy-skill' ? 'managed-by-billy' : null
      },
      async listDirs() {
        return ['keep', 'stale']
      },
    }

    const result = await service.syncSkills('ws_1', shell)

    expect(result.removed).toEqual(['stale'])
    expect(execs.some((command) => command.includes("rm -rf '.agents/stale'"))).toBe(true)
    expect(writes).toContain('.agents/keep/SKILL.md')
  })
})

describe('P6 推送同步：只刷凭据，不装包', () => {
  it('syncCredentials 不执行安装 / 技能，只重新落地凭据并写版本', async () => {
    const { service } = makeService()
    const { shell, execs, writes } = makeShell()

    const result = await service.syncCredentials('ws_1', shell, CONTAINER_FEATURES)

    // 没有 verify / 安装命令（推送同步不碰包）
    expect(execs).toEqual([])
    expect(writes.some((item) => item.path.startsWith('.agents/'))).toBe(false)
    expect(writes.some((item) => item.path === '~/.my.cnf')).toBe(true)
    // 版本 = 活跃条数-最大 version（与 main 用同一个函数）
    expect(result.version).toBe('1-3')
    const setup = writes.find((item) => item.path === '.billy/setup.json')
    expect(JSON.parse(setup!.content)).toMatchObject({ credentialVersion: result.version })
    expect(result.env.MYSQL_PWD).toBe('p@ss')
  })
})

describe('失败不阻断：单项失败只进报告', () => {
  it('安装失败也继续走技能与凭据，报告里记 failed', async () => {
    const { service } = makeService()
    const failingShell: SetupShell = {
      async exec(command) {
        if (command === PACKAGE.verify) return fail('command not found')
        if (command.startsWith('npm install')) return fail('network unreachable')
        return ok()
      },
      async write() {},
      async read() {
        return null
      },
    }

    const { report } = await service.run('ws_1', failingShell, CONTAINER_FEATURES)

    expect(report.packages[0].outcome).toBe('failed')
    expect(report.packages[0].message).toContain('network unreachable')
    expect(report.skills[0].outcome).toBe('materialized')
    expect(report.credentials[0].outcome).toBe('materialized')
  })

  it('凭据不可用（denied）→ 不写文件，报告记 denied', async () => {
    const { service } = makeService({
      resolve: async () => [
        {
          name: 'lark',
          provider: 'lark',
          status: 'revoked',
          expiresAt: null,
          config: {},
          secret: null,
          inject: [],
          message: '凭据已吊销',
        },
      ],
      credentialNames: ['lark'],
    })
    const { shell, writes } = makeShell()

    const { report } = await service.run('ws_1', shell, CONTAINER_FEATURES)

    expect(report.credentials[0]).toMatchObject({ name: 'lark', outcome: 'denied' })
    expect(writes.some((item) => item.path === '~/.my.cnf')).toBe(false)
  })

  it('凭据解析整体失败 → 所有名字记 failed，初始化仍完成', async () => {
    const { service } = makeService({
      resolve: async () => {
        throw new Error('HTTP 503')
      },
      credentialNames: ['a', 'b'],
    })
    const { shell, writes } = makeShell()

    const { env, report, resolved } = await service.run('ws_1', shell, CONTAINER_FEATURES)

    expect(report.credentials.map((item) => item.outcome)).toEqual(['failed', 'failed'])
    expect(env).toEqual({ FOO: 'bar' })
    expect(writes.some((item) => item.path === '.billy/setup.json')).toBe(true)
    // 暂态失败必须显性化：空清单不等于"没有凭据"，否则补偿永远不会触发（issue 9）
    expect(resolved).toBe(false)
  })

  it('没有绑定任何凭据 → resolved=true（不是失败，不触发补偿）', async () => {
    const { service } = makeService({ credentialNames: [] })
    const { shell } = makeShell()

    const { resolved, report } = await service.run('ws_1', shell, CONTAINER_FEATURES)

    expect(resolved).toBe(true)
    expect(report.credentials).toEqual([])
  })
})

describe('技能物化：单文件失败不连坐，正文优先，失败不写幂等标记', () => {
  it('素材写失败 → 报告 partial、SKILL.md 仍然落地、不写 done 标记', async () => {
    const { service } = makeService({
      skills: [
        {
          key: 'design',
          files: [
            { path: 'assets/photos.json', content: '{}' },
            { path: 'references/a.md', content: 'ref' },
            { path: 'SKILL.md', content: '# body' },
          ],
        },
      ],
    })
    const writes: string[] = []
    const shell: SetupShell = {
      async exec() {
        return ok()
      },
      async write(path) {
        // 大文件撞 argv 上限：模拟 2026-11-22 现场
        if (path.endsWith('assets/photos.json')) throw new Error('argument list too long')
        writes.push(path)
      },
      async read() {
        return null
      },
    }

    const { report } = await service.run('ws_1', shell, CONTAINER_FEATURES)

    expect(report.skills).toEqual([
      {
        skillKey: 'design',
        outcome: 'partial',
        message: expect.stringContaining('assets/photos.json'),
      },
    ])
    // SKILL.md 必须最先写：正文在，技能才算存在
    expect(writes[0]).toBe('.agents/design/SKILL.md')
    expect(writes).toContain('.agents/design/references/a.md')
    // 没写全就不落幂等标记，下次 ensure 还会重试
    expect(writes.some((path) => path.startsWith('.billy/setup/'))).toBe(false)
  })

  it('全部文件都失败 → 报告 failed，同样不写标记', async () => {
    const { service } = makeService({
      skills: [{ key: 'broken', files: [{ path: 'SKILL.md', content: '# body' }] }],
    })
    const writes: string[] = []
    const shell: SetupShell = {
      async exec() {
        return ok()
      },
      async write(path) {
        writes.push(path)
        throw new Error('disk full')
      },
      async read() {
        return null
      },
    }

    const { report } = await service.run('ws_1', shell, CONTAINER_FEATURES)

    expect(report.skills[0]).toMatchObject({ skillKey: 'broken', outcome: 'failed' })
    // 只尝试过技能文件与版本文件，没有任何 done 标记
    expect(writes.filter((path) => path.startsWith('.billy/setup/'))).toEqual([])
  })
})
