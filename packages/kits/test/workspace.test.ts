import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '../src/foundation/command/command.runner.js'
import type { AppLogger } from '../src/foundation/logger/app-logger.js'
import { WorkspaceConfigSchema } from '../src/workspace/workspace.config.js'
import {
  buildBwrapArgs,
  buildSeatbeltProfile,
  probeSandbox,
} from '../src/workspace/workspace.sandbox.js'
import { WorkspaceRuntimeService } from '../src/workspace/workspace.runtime.js'
import type { SandboxCapability, WorkspaceFileAccess } from '../src/workspace/workspace.types.js'

/**
 * 工作区运行时的安全语义（`docs/design/workspace-runtime.md`）：
 *
 * 1. **fail closed**：沙箱不可用就拒绝执行，绝不退回宿主进程；
 * 2. **会话只能选沙箱内的文件权限**（只读 / 可写），选不到"出沙箱"；
 * 3. `AGENT_WORKSPACE_MODE=off` 是唯一的"出沙箱"入口，且只在自托管由部署方显式打开。
 *
 * 全部用桩：探测注入假实现、命令执行也注入假实现 —— 这套用例在 macOS / Linux / Windows
 * 上跑出同一份结论。
 */

const silentLogger = {
  debug: () => undefined,
  log: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as AppLogger

const okResult = (command: string): CommandResult => ({
  ok: true,
  command,
  shell: '/bin/sh',
  cwd: '/tmp',
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  aborted: false,
  truncated: false,
  durationMs: 1,
})

/** 假 runner：记录拿到的命令行，按需返回成功 */
const fakeRunner = () => {
  const commands: string[] = []
  const runner = {
    run: async (options: { command: string }): Promise<CommandResult> => {
      commands.push(options.command)
      return okResult(options.command)
    },
  }
  return { runner: runner as unknown as CommandRunner, commands }
}

const available: SandboxCapability = {
  available: true,
  impl: process.platform === 'darwin' ? 'seatbelt' : 'bwrap',
  binary: process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap',
  probedAt: new Date().toISOString(),
}

const unavailable: SandboxCapability = {
  available: false,
  reason: { code: 'userns-denied', message: '容器内禁止用户命名空间' },
  probedAt: new Date().toISOString(),
}

const build = (options: {
  mode?: 'enforce' | 'off'
  sandbox?: SandboxCapability
} = {}) => {
  const { runner, commands } = fakeRunner()
  const service = new WorkspaceRuntimeService(
    WorkspaceConfigSchema.parse({
      mode: options.mode ?? 'enforce',
      sandboxNetwork: 'deny',
    }),
    runner,
    silentLogger,
    async () => options.sandbox ?? available,
  )
  return { service, commands }
}

describe('执行：会话只能选沙箱内的文件权限', () => {
  it('默认 workspace-write：命令被沙箱包装，出参标 sandbox', async () => {
    const { service, commands } = build()
    const result = await service.exec({
      command: 'echo hi',
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    })
    expect(result.runtime).toBe('sandbox')
    expect(result.mode).toBe('workspace-write')
    expect(result.command).toBe('echo hi')
    expect(commands[0]).toContain(process.platform === 'darwin' ? 'sandbox-exec' : 'bwrap')
  })

  it('只读：同样在沙箱里跑，但模式是 read-only（包装里不再给工作区写权限）', async () => {
    const { service, commands } = build()
    const result = await service.exec({
      command: 'touch x',
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      fileAccess: 'read-only' satisfies WorkspaceFileAccess,
    })
    expect(result.runtime).toBe('sandbox')
    expect(result.mode).toBe('read-only')
    expect(commands).toHaveLength(1)
  })

  it('伪造的 danger 请求在 enforce 下不生效：仍按沙箱可写执行', async () => {
    const { service } = build()
    // 信封可以被伪造 / 被越权写入：enforce 下只认两档允许值，绝不执行 danger-full-access
    const result = await service.exec({
      command: 'echo hi',
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
      fileAccess: 'danger-full-access' as never,
    })
    expect(result.runtime).toBe('sandbox')
    expect(result.mode).toBe('workspace-write')
  })
})

describe('fail closed：隔离不可用就不执行', () => {
  it('enforce + 沙箱不可用：不执行命令，返回可读结论', async () => {
    const { service, commands } = build({ sandbox: unavailable })
    const result = await service.exec({
      command: 'rm -rf /',
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(result.reason).toContain('容器内禁止用户命名空间')
    expect(commands).toEqual([])
  })

  it('部署显式 mode=off：整条执行降级为 dangerous，并如实标注', async () => {
    const { service, commands } = build({ mode: 'off', sandbox: unavailable })
    const result = await service.exec({ command: 'echo hi', execution: undefined } as never)
    expect(result.runtime).toBe('local')
    expect(result.mode).toBe('danger-full-access')
    expect(commands).toEqual(['echo hi'])
  })
})

describe('status：部署能力对管理页 / `/info` 的口径', () => {
  it('enforce：给出两档文件权限 + 沙箱能力', async () => {
    const { service } = build()
    const status = await service.status()
    expect(status.mode).toBe('enforce')
    expect(status.fileAccessOptions).toEqual(['workspace-write', 'read-only'])
    expect(status.sandbox.available).toBe(true)
  })

  it('off：没有隔离，也就没有"文件权限"可谈', async () => {
    const { service } = build({ mode: 'off', sandbox: unavailable })
    const status = await service.status()
    expect(status.mode).toBe('off')
    expect(status.fileAccessOptions).toEqual([])
  })
})

describe('配置默认值：web 产品的安全底线', () => {
  it('默认 enforce + 断网', () => {
    const config = WorkspaceConfigSchema.parse({})
    expect(config.mode).toBe('enforce')
    expect(config.sandboxNetwork).toBe('deny')
  })
})

describe('探测：用真实判据，不看二进制是否存在', () => {
  const base = {
    timeoutMs: 1000,
    network: 'deny' as const,
    run: async () => okResult('true'),
    resolveBinary: () => '/usr/bin/true',
  }

  it('Windows 没有可用的 OS 沙箱', async () => {
    const capability = await probeSandbox({ ...base, platform: 'win32' })
    expect(capability.available).toBe(false)
    expect(capability.reason?.code).toBe('platform-unsupported')
  })

  it('二进制不存在 → binary-missing', async () => {
    const capability = await probeSandbox({
      ...base,
      platform: 'linux',
      resolveBinary: () => null,
    })
    expect(capability.reason?.code).toBe('binary-missing')
  })

  it('bwrap 跑不起来且是权限原因 → userns-denied（容器里最常见）', async () => {
    const capability = await probeSandbox({
      ...base,
      platform: 'linux',
      run: async () => ({
        ...okResult('bwrap'),
        ok: false,
        exitCode: 1,
        stderr: 'bwrap: No permissions to create new namespace.',
      }),
    })
    expect(capability.available).toBe(false)
    expect(capability.reason?.code).toBe('userns-denied')
  })

  it('探测通过 = 真能跑（返回可用实现）', async () => {
    const capability = await probeSandbox({ ...base, platform: 'darwin' })
    expect(capability.available).toBe(true)
    expect(capability.impl).toBe('seatbelt')
  })
})

describe('沙箱策略构造', () => {
  it('seatbelt / workspace-write：工作区可写、断网', () => {
    const profile = buildSeatbeltProfile({
      workspaceRoot: '/ws/session',
      writableDirs: ['/tmp'],
      denyPaths: ['/home/u/.ssh'],
      network: 'deny',
      mode: 'workspace-write',
    })
    expect(profile).toContain('(deny default)')
    expect(profile).toContain('(deny file-read* (subpath "/home/u/.ssh"))')
    expect(profile).toContain('(allow file-write* (subpath "/ws/session") (subpath "/tmp"))')
    expect(profile).toContain('(deny network*)')
  })

  it('seatbelt / read-only：工作区不出现在可写列表里', () => {
    const profile = buildSeatbeltProfile({
      workspaceRoot: '/ws/session',
      writableDirs: ['/tmp'],
      denyPaths: [],
      network: 'deny',
      mode: 'read-only',
    })
    expect(profile).not.toContain('"/ws/session"')
    expect(profile).toContain('(allow file-write* (subpath "/tmp"))')
  })

  it('bwrap / read-only：不 bind 工作区；workspace-write 才 bind', () => {
    const base = {
      workspaceRoot: '/ws/session',
      cwd: '/ws/session/sub',
      command: 'echo hi',
      writableDirs: ['/tmp'],
      network: 'deny' as const,
    }
    const readOnly = buildBwrapArgs({ ...base, mode: 'read-only' })
    const writable = buildBwrapArgs({ ...base, mode: 'workspace-write' })
    expect(readOnly).not.toContain('--bind')
    expect(writable).toEqual(expect.arrayContaining(['--bind', '/ws/session', '/ws/session']))
    expect(readOnly).toContain('--unshare-net')
  })
})
