import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { quote } from 'shell-quote'
import type {
  SandboxCapability,
  SandboxImpl,
  SandboxMode,
  SandboxProbeInput,
  WorkspaceReason,
} from './workspace.types.js'

/**
 * OS 沙箱的**实现层**：把一条命令包装成"只能读写工作区"的进程。
 *
 * - macOS：`sandbox-exec -f <profile> /bin/sh -c <cmd>`（seatbelt，10.15 起标 deprecated 但仍在用）；
 * - Linux：`bwrap … --ro-bind / / --bind <ws> <ws> /bin/sh -c <cmd>`（bubblewrap）。
 *
 * 两条纪律：
 * 1. **探测与执行走同一份构造逻辑** —— 探测用 `true` 跑一遍完整包装，
 *    于是"探测通过"意味着真的能跑，而不是"二进制存在"；
 * 2. **路径先 `realpath`** —— macOS 的 `/tmp` 是 `/private/tmp` 的软链，
 *    直接写 `/tmp` 进 profile 会得到"写不进去"的怪现象（实测过）。
 */

/** 默认**可写**目录：工作区之外只放缓存与临时目录，保证 `npm` / `pip` 这类工具还能用 */
export const defaultWritableDirs = (home = homedir()): string[] => [
  tmpdir(),
  '/private/tmp',
  '/private/var/folders',
  join(home, '.cache'),
  join(home, 'Library', 'Caches'),
  join(home, '.npm'),
  join(home, '.pnpm-store'),
  join(home, '.yarn'),
  join(home, '.bun'),
  join(home, '.gradle'),
  join(home, '.m2'),
  join(home, '.cargo'),
  join(home, '.local', 'share'),
]

/** 默认**禁读**目录：真正的凭据所在（其余目录仍可读，否则 git / npm 立刻不可用） */
export const defaultDenyPaths = (home = homedir()): string[] => [
  join(home, '.ssh'),
  join(home, '.aws'),
  join(home, '.gnupg'),
  join(home, '.kube'),
  join(home, '.docker'),
  join(home, '.netrc'),
  join(home, '.pgpass'),
  join(home, '.git-credentials'),
  join(home, '.npmrc'),
  join(home, '.config', 'gh'),
  // 连接器把用户授权落在 CLI 的 HOME 下，不能给命令读到
  join(home, '.billy', 'lark-cli'),
]

/** realpath 失败（路径还不存在）时退回字面绝对路径 */
const realOrSelf = async (path: string): Promise<string> =>
  realpath(path).catch(() => resolve(path))

const sbplString = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** subpath 规则组：`(subpath "a") (subpath "b")` */
const sbplSubpaths = (paths: string[]): string =>
  paths.map((path) => `(subpath ${sbplString(path)})`).join(' ')

/**
 * seatbelt 策略（SBPL）。
 *
 * 语义要点：**后出现的规则覆盖先出现的**（实测：先 `allow file-read*` 再 `deny` 某目录，
 * 该目录确实读不到；`deny` 之后再 `allow` 又会放开）。所以顺序是
 * 全放开 → 禁凭据 → 只允许写工作区与缓存 → 网络。
 *
 * 默认拒绝一切、再逐项放开，不会出现"忘了 deny 就全开"。
 */
export const buildSeatbeltProfile = (input: {
  workspaceRoot: string
  writableDirs: string[]
  denyPaths: string[]
  network: 'allow' | 'deny'
  /** `read-only` 时工作区**不可写**（临时目录仍可写：那是易失的，不构成数据破坏） */
  mode: SandboxMode
}): string => {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix*)',
    '(allow file-read*)',
  ]
  if (input.denyPaths.length > 0) {
    lines.push(`(deny file-read* ${sbplSubpaths(input.denyPaths)})`)
  }
  const writable =
    input.mode === 'read-only'
      ? input.writableDirs
      : [input.workspaceRoot, ...input.writableDirs]
  lines.push(`(allow file-write* ${sbplSubpaths(writable)})`)
  lines.push(
    '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))',
  )
  lines.push(input.network === 'allow' ? '(allow network*)' : '(deny network*)')
  return `${lines.join('\n')}\n`
}

/** bwrap 的参数（不含二进制本身）：只读挂整机，工作区与缓存单独绑定为可写 */
export const buildBwrapArgs = (input: {
  workspaceRoot: string
  cwd: string
  command: string
  writableDirs: string[]
  network: 'allow' | 'deny'
  /** `read-only` 时不把工作区 bind 成可写（`--ro-bind / /` 已覆盖它） */
  mode: SandboxMode
}): string[] => [
  '--die-with-parent',
  '--new-session',
  '--unshare-user',
  '--unshare-pid',
  '--unshare-ipc',
  '--unshare-uts',
  '--unshare-cgroup',
  ...(input.network === 'deny' ? ['--unshare-net'] : []),
  '--cap-drop',
  'ALL',
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  '--tmpfs',
  '/tmp',
  ...input.writableDirs.flatMap((dir) => ['--bind-try', dir, dir]),
  ...(input.mode === 'read-only' ? [] : ['--bind', input.workspaceRoot, input.workspaceRoot]),
  '--chdir',
  input.cwd,
  '/bin/sh',
  '-c',
  input.command,
]

export interface SandboxInvocation {
  /** 完整命令行（交给 `CommandRunner`，由宿主 shell 解释） */
  command: string
  /** 收尾：删掉临时 profile（bwrap 无临时文件） */
  cleanup: () => Promise<void>
}

/**
 * 构造一次沙箱执行的命令行。
 *
 * `profileDir` 可注入：探测与执行用同一个目录策略，测试里给临时目录。
 */
export const buildSandboxInvocation = async (input: {
  impl: SandboxImpl
  binary: string
  workspaceRoot: string
  cwd: string
  command: string
  network: 'allow' | 'deny'
  mode: SandboxMode
  profileDir?: string
}): Promise<SandboxInvocation> => {
  const workspaceRoot = await realOrSelf(input.workspaceRoot)
  const cwd = await realOrSelf(input.cwd)

  if (input.impl === 'bwrap') {
    const writableDirs = await Promise.all(defaultWritableDirs().map(realOrSelf))
    const args = buildBwrapArgs({
      workspaceRoot,
      cwd,
      command: input.command,
      writableDirs,
      network: input.network,
      mode: input.mode,
    })
    return { command: quote([input.binary, ...args]), cleanup: async () => {} }
  }

  const denyPaths = await Promise.all(defaultDenyPaths().map(realOrSelf))
  const writableDirs = await Promise.all(
    defaultWritableDirs()
      .filter((dir) => !dir.startsWith(workspaceRoot))
      .map(realOrSelf),
  )
  const profile = buildSeatbeltProfile({
    workspaceRoot,
    writableDirs,
    denyPaths,
    network: input.network,
    mode: input.mode,
  })
  const dir = input.profileDir ?? tmpdir()
  const file = join(dir, `billy-sandbox-${randomUUID()}.sb`)
  await writeFile(file, profile, { mode: 0o600 })
  return {
    command: quote([input.binary, '-f', file, '/bin/sh', '-c', input.command]),
    cleanup: async () => {
      await rm(file, { force: true }).catch(() => undefined)
    },
  }
}

const unavailable = (
  code: WorkspaceReason['code'],
  message: string,
): SandboxCapability => ({
  available: false,
  reason: { code, message },
  probedAt: new Date().toISOString(),
})

const looksLikeUsernsDenied = (text: string): boolean =>
  /unshare|operation not permitted|permission denied|clone_newuser|no permissions to create new namespace/i.test(
    text,
  )

/**
 * 沙箱能力探测：**用 `true` 跑一遍完整包装**，退出码 0 才算可用。
 *
 * 只看二进制是否存在会误判：容器里 `bwrap` 装着、unprivileged userns 被禁，一样起不来。
 * 探测同时验证了 profile 语法 —— profile 写错也会在这里暴露，而不是在执行时炸。
 */
export const probeSandbox = async (
  input: SandboxProbeInput,
): Promise<SandboxCapability> => {
  if (input.platform === 'win32') {
    return unavailable(
      'platform-unsupported',
      'Windows 不提供可用的 OS 沙箱；可用非沙箱执行，或把服务部署到 WSL2 / Linux',
    )
  }
  if (input.platform !== 'darwin' && input.platform !== 'linux') {
    return unavailable(
      'platform-unsupported',
      `当前系统（${input.platform}）没有实现 OS 沙箱`,
    )
  }

  const impl: SandboxImpl = input.platform === 'darwin' ? 'seatbelt' : 'bwrap'
  const binaryName = impl === 'seatbelt' ? 'sandbox-exec' : 'bwrap'
  const binary = input.resolveBinary(binaryName)
  if (!binary) {
    return unavailable('binary-missing', `未找到 ${binaryName}，无法启用沙箱`)
  }

  const probeDir = await mkdtemp(join(tmpdir(), 'billy-sandbox-probe-')).catch(
    () => null,
  )
  if (!probeDir) {
    return unavailable('sandbox-unavailable', '无法创建探测目录')
  }
  try {
    const invocation = await buildSandboxInvocation({
      impl,
      binary,
      workspaceRoot: probeDir,
      cwd: probeDir,
      command: 'true',
      network: input.network,
      // 探测用更宽松的一档：它能跑通，只读一定也能跑通
      mode: 'workspace-write',
      profileDir: probeDir,
    })
    try {
      const result = await input.run(invocation.command, input.timeoutMs)
      if (result.ok) {
        return {
          available: true,
          impl,
          binary,
          probedAt: new Date().toISOString(),
        }
      }
      const detail = `${result.stderr}\n${result.reason ?? ''}`.trim()
      if (impl === 'bwrap' && looksLikeUsernsDenied(detail)) {
        return unavailable(
          'userns-denied',
          '当前环境禁止创建用户命名空间（多见于容器 / Pod 内），bubblewrap 无法启用',
        )
      }
      return unavailable(
        'sandbox-unavailable',
        `沙箱探测失败：${detail.slice(0, 300) || '未知原因'}`,
      )
    } finally {
      await invocation.cleanup()
    }
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
