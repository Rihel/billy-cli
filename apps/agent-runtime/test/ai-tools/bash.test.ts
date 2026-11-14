import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandRunner, WorkspaceConfigSchema, WorkspaceRuntimeService } from '@repo/kits'
import { describe, expect, it } from 'vitest'
import { BashTool } from '../../src/modules/ai/tools/bash.tool.js'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import {
  buildToolStackDeps,
  makeToolContext,
  silentLogger,
  specByKey,
  TEST_TOOL_ENV_CAPS,
} from '../helpers/ai-tool-stack.js'

/**
 * `bash` 的单测（策略的完整矩阵见 `test/ai-command-core.test.ts`；
 * 这份文件是标准测试集要求的"每个工具一个测试文件"，覆盖**工具本体**）。
 */
/**
 * 测试固定用**不做隔离**的执行路径（`mode: 'off'`）：这份文件验证的是工具本体
 * （工作区、边界、分页、审计），隔离语义在 `@repo/kits` 的 `workspace.test.ts` 里钉死。
 */
const buildRuntime = () =>
  new WorkspaceRuntimeService(
    WorkspaceConfigSchema.parse({ mode: 'off' }),
    new CommandRunner(),
    silentLogger as never,
    async () => ({ available: false, probedAt: new Date().toISOString() }),
  )

const build = (caps = TEST_TOOL_ENV_CAPS) => {
  const deps = buildToolStackDeps({ caps })
  const spec = specByKey(new BashTool(buildRuntime(), silentLogger as never, caps), TOOL_KEYS.bash)
  return { deps, spec }
}

const capsWithRoot = (root: string) => ({
  ...TEST_TOOL_ENV_CAPS,
  command: { ...TEST_TOOL_ENV_CAPS.command!, workDir: root },
})

describe('bash（执行命令行命令）', () => {
  it('真的执行一条跨平台命令，出参里带 exitCode / stdout / cwd', async () => {
    const { deps, spec } = build(capsWithRoot(tmpdir()))
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings })
    const result = (await spec.exec({ command: 'echo billy-tool-ok' }, ctx as never)) as {
      ok: boolean
      stdout: string
      cwd: string
      exitCode: number
    }
    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('billy-tool-ok')
    expect(result.cwd).toBe(join(tmpdir(), 'conv-test'))
    expect(result.exitCode).toBe(0)
  })

  it('工作根目录不存在时，执行前自动创建（AI 的 workspace 被删也能继续）', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'billy-command-workspace-'))
    const root = join(temp, 'session-workspace')
    try {
      const { deps, spec } = build(capsWithRoot(root))
      const settings = await deps.config.settings(spec)
      const ctx = makeToolContext({ spec, settings })
      const result = (await spec.exec({ command: 'echo workspace-ready' }, ctx as never)) as {
        ok: boolean
        stdout: string
        cwd: string
      }
      expect(result.ok).toBe(true)
      expect(result.stdout).toContain('workspace-ready')
      expect(result.cwd).toBe(join(root, 'conv-test'))
      // 根目录真的被建出来了（不是只把 cwd 改成不存在的路径）
      expect((await stat(join(root, 'conv-test'))).isDirectory()).toBe(true)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('启动时按 AGENT_COMMAND_WORK_DIR 创建根目录（建不出来也不拦启动）', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'billy-command-root-'))
    const root = join(temp, 'agent-workspace')
    try {
      const tool = new BashTool(buildRuntime(), silentLogger as never, {
        ...TEST_TOOL_ENV_CAPS,
        command: {
          ...TEST_TOOL_ENV_CAPS.command!,
          workDir: root,
        },
      })
      await expect(tool.onApplicationBootstrap()).resolves.toBeUndefined()
      expect((await stat(root)).isDirectory()).toBe(true)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('precheck：`cwd` 越界时返回一句说明（由网关翻成 precheck-failed 结论）', async () => {
    const { deps, spec } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings })
    const reason = await spec.precheck?.({ command: 'ls', cwd: '../../' } as never, ctx as never)
    expect(String(reason)).toContain('本会话工作区')
  })

  it('precheck：工作目录之内放行（返回 null）', async () => {
    const { deps, spec } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings })
    expect(await spec.precheck?.({ command: 'ls' } as never, ctx as never)).toBeNull()
  })

  it('声明了分页（命令输出可能有几十 KB，超了就给模型一页 + 句柄）', () => {
    const { spec } = build()
    expect(spec.paginate?.pageBytes).toBeGreaterThan(0)
  })

  it('子 agent 也拿得到（不是委派类，也没有 child: deny）', () => {
    const { spec } = build()
    expect(spec.delegation).toBeUndefined()
    expect(spec.child ?? 'allow').toBe('allow')
  })
})

/**
 * 执行环境：**默认沙箱、会话只能选只读/可写、隔离不可用就拒绝执行**。
 *
 * 这里用假 runner，避免依赖 CI 机器上真的有 sandbox-exec / bwrap；
 * 隔离语义本身在 `@repo/kits` 的 `workspace.test.ts` 里钉死，这份只验"工具把信封里的权限传对了"。
 */
describe('bash（执行环境）', () => {
  const resultOf = (command: string) => ({
    ok: true,
    command,
    shell: '/bin/sh',
    cwd: '/tmp',
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    timedOut: false,
    aborted: false,
    truncated: false,
    durationMs: 1,
  })

  const runtimeWith = (options: { mode?: 'enforce' | 'off'; available?: boolean }) => {
    const commands: string[] = []
    const runner = {
      run: async (input: { command: string }) => {
        commands.push(input.command)
        return resultOf(input.command)
      },
    }
    const config = WorkspaceConfigSchema.parse({
      mode: options.mode ?? 'enforce',
      sandboxNetwork: 'deny',
    })
    const runtime = new WorkspaceRuntimeService(
      config,
      runner as never,
      silentLogger as never,
      async () => ({
        available: options.available ?? true,
        ...(options.available === false
          ? { reason: { code: 'platform-unsupported' as const, message: '没有沙箱' } }
          : { impl: 'seatbelt' as const, binary: '/usr/bin/sandbox-exec' }),
        probedAt: new Date().toISOString(),
      }),
    )
    return { runtime, commands }
  }

  const exec = async (
    runtime: WorkspaceRuntimeService,
    fileAccess?: 'read-only' | 'workspace-write',
  ) => {
    const deps = buildToolStackDeps({ caps: capsWithRoot(tmpdir()) })
    const spec = specByKey(
      new BashTool(runtime, silentLogger as never, capsWithRoot(tmpdir())),
      TOOL_KEYS.bash,
    )
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({
      spec,
      settings,
      envelope: {
        conversationId: 'conv-test',
        parentRunId: 'run-test',
        triggeredBy: 'user-test',
        ...(fileAccess ? { fileAccess } : {}),
      },
    })
    return (await spec.exec({ command: 'echo hi' }, ctx as never)) as {
      ok: boolean
      runtime: string
      mode: string
      reason?: string
      command: string
    }
  }

  it('默认走沙箱（会话没选就是可写）：命令行被包装，出参标 sandbox', async () => {
    const { runtime, commands } = runtimeWith({})
    const result = await exec(runtime)
    expect(result.runtime).toBe('sandbox')
    expect(result.mode).toBe('workspace-write')
    expect(result.command).toBe('echo hi')
    expect(commands[0]).toContain('sandbox-exec')
  })

  it('会话选只读：仍在沙箱里跑，模式是 read-only', async () => {
    const { runtime } = runtimeWith({})
    const result = await exec(runtime, 'read-only')
    expect(result.runtime).toBe('sandbox')
    expect(result.mode).toBe('read-only')
  })

  it('隔离不可用：**拒绝执行**（不退回宿主进程）', async () => {
    const { runtime, commands } = runtimeWith({ available: false })
    const result = await exec(runtime)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('没有沙箱')
    expect(commands).toEqual([])
  })

  it('部署显式 mode=off：以宿主进程执行，并如实标注', async () => {
    const { runtime, commands } = runtimeWith({ mode: 'off', available: false })
    const result = await exec(runtime)
    expect(result.runtime).toBe('local')
    expect(result.mode).toBe('danger-full-access')
    expect(commands).toEqual(['echo hi'])
  })
})
