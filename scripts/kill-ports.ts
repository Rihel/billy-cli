#!/usr/bin/env node
/**
 * 跨平台按端口停进程（生产 start / 本地起服务后收尾用）。
 *
 * 用法：
 *   pnpm kill:start              # 默认停 web 9840 / admin 9845 / server 9989
 *   pnpm kill:port 3001 8080     # 停指定端口
 *   ... --dry-run                # 只列出将被停止的进程（-n 同义）
 *   ... --force                  # 跳过「进程不属于本仓库」的保护
 *
 * 跨平台：
 *   - macOS / Linux：lsof 找监听 PID（lsof 查不到时依次退到 lsof -i、sudo -n lsof、ss），
 *     再用 cwd 确认进程属于本仓库；
 *   - Windows：netstat -ano 找监听 PID，再用 PowerShell 取命令行确认路径；
 *     终止统一走 taskkill /T /F（连子孙一起收），POSIX 先 SIGTERM、超时再 SIGKILL。
 *
 * lsof 查不到不等于端口空闲：脚本会用 TCP 连接探针独立判断端口是否真的在监听。
 * 「端口在监听但定位不到进程」时明确报错并给排查命令，绝不误报「未被占用」。
 */
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import net from 'node:net'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import colors from 'picocolors'

const IS_WIN = process.platform === 'win32'
const ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_PORTS = [9840, 9845, 9989]
const TERM_GRACE_MS = 2000

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run') || args.includes('-n')
const force = args.includes('--force')
const help = args.includes('--help') || args.includes('-h')

if (help) {
  console.log(`用法：pnpm kill:start [端口...] [--dry-run] [--force]

  不带端口时默认 ${DEFAULT_PORTS.join(' / ')}（web / admin / server）
  --dry-run, -n  只列出会被停止的进程，不做终止
  --force        跳过「进程不属于本仓库」的保护（误杀风险自负）
`)
  process.exit(0)
}

const ports = args
  .filter((arg) => !arg.startsWith('-'))
  .map((arg) => Number(arg))
  .filter((port) => Number.isInteger(port) && port > 0 && port < 65536)

if (ports.length === 0) {
  if (args.some((arg) => !arg.startsWith('-'))) {
    console.error(colors.red('端口参数不合法（需要 1-65535 的整数）'))
    process.exit(1)
  }
  ports.push(...DEFAULT_PORTS)
}

type PortState = 'open' | 'closed' | 'unknown'

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function run(command: string, commandArgs: string[]): string {
  try {
    return execFileSync(command, commandArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    })
  } catch {
    return ''
  }
}

/** 不带 sudo 的 lsof；失败（没装 / 没权限 / 无结果）一律返回空 */
function lsofPids(portArgs: string[]): number[] {
  return run('lsof', ['-nP', ...portArgs, '-t'])
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
}

/**
 * lsof 有时查不到（进程属于其它用户、容器转发、或干脆没装 lsof）。
 * 只找 TCP LISTEN：不加 `-i:port` 这类宽条件，避免把「连到远端 9840 的客户端」误当成服务端进程。
 * 依次尝试：lsof → sudo -n lsof（无密码时失败，不会卡终端）→ Linux ss。
 */
function listPosixPids(port: number): number[] {
  const listenArgs = [`-iTCP:${port}`, '-sTCP:LISTEN']
  const direct = lsofPids(listenArgs)
  if (direct.length > 0) return direct

  // 无密码 sudo 能覆盖「别的用户起的进程」；需要输密码时 -n 会直接失败，不会卡住终端
  const sudo = run('sudo', ['-n', 'lsof', '-nP', ...listenArgs, '-t'])
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
  if (sudo.length > 0) return sudo

  // Linux 上没有 lsof 时用 ss（-p 只能看到有权限看的进程）
  const ss = run('ss', ['-ltnp'])
  if (ss) {
    const pids = new Set<number>()
    const linePattern = new RegExp(`:${port}\\s`)
    for (const line of ss.split('\n')) {
      if (!linePattern.test(line)) continue
      for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]))
    }
    if (pids.size > 0) return [...pids]
  }

  return []
}

function listListeningPids(port: number): number[] {
  if (IS_WIN) {
    const pattern = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'i')
    const pids = new Set<number>()
    for (const line of run('netstat', ['-ano', '-p', 'TCP']).split('\n')) {
      const match = pattern.exec(line.trim())
      if (match) pids.add(Number(match[1]))
    }
    return [...pids]
  }

  return listPosixPids(port)
}

/** 独立于 lsof 的占用判断：TCP 探针能连上，就说明端口确实在监听 */
function probePort(port: number, host: string): Promise<PortState> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (state) => {
      socket.destroy()
      resolve(state)
    }
    socket.setTimeout(400)
    socket.once('connect', () => done('open'))
    socket.once('timeout', () => done('unknown'))
    socket.once('error', (error) => done(error.code === 'ECONNREFUSED' ? 'closed' : 'unknown'))
  })
}

async function portState(port: number): Promise<PortState> {
  const states = await Promise.all([probePort(port, '127.0.0.1'), probePort(port, '::1')])
  if (states.includes('open')) return 'open'
  if (states.every((state) => state === 'closed')) return 'closed'
  return 'unknown'
}

function isOwnedByRepo(pid: number): boolean {
  if (IS_WIN) {
    // Win32_Process 没有 cwd，只能看命令行里有没有仓库路径
    const command = run('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ])
    const normalized = command.toLowerCase().replaceAll('\\', '/')
    return normalized.includes(ROOT.toLowerCase().replaceAll('\\', '/'))
  }

  const cwd = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n')
    .find((line) => line.startsWith('n'))
    ?.slice(1)
  if (!cwd) return false
  try {
    const resolved = realpathSync(cwd)
    return resolved === ROOT || resolved.startsWith(`${ROOT}/`)
  } catch {
    return false
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function terminate(pid: number): Promise<void> {
  if (IS_WIN) {
    run('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + TERM_GRACE_MS
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return
    await sleep(100)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已退出
  }
}

async function waitPortFree(port: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (listListeningPids(port).length === 0 && (await portState(port)) !== 'open') return true
    await sleep(100)
  }
  return false
}

function printUnknownOwnerHint(port: number): void {
  console.log(
    colors.yellow(
      `! ${port} 在监听，但定位不到进程（可能属于其它用户 / 容器转发 / 系统服务，或 lsof 不可用）`,
    ),
  )
  console.log(colors.dim(`  macOS/Linux: sudo lsof -nP -iTCP:${port} -sTCP:LISTEN`))
  console.log(colors.dim(`  Windows:     netstat -ano | findstr :${port}`))
  console.log(colors.dim(`  容器:        docker ps --filter publish=${port}`))
}

let failed = 0

for (const port of ports) {
  const pids = listListeningPids(port)
  const state = await portState(port)

  if (pids.length === 0) {
    if (state === 'closed') {
      console.log(colors.dim(`- ${port} 未被占用`))
    } else {
      // 查不到 PID 但探针显示在监听 / 状态不明：绝不能报「空闲」
      printUnknownOwnerHint(port)
      failed += 1
    }
    continue
  }

  for (const pid of pids) {
    if (!force && !isOwnedByRepo(pid)) {
      console.log(colors.yellow(`! ${port} 的进程 ${pid} 不属于本仓库，已跳过（--force 可强制）`))
      failed += 1
      continue
    }
    if (dryRun) {
      console.log(colors.cyan(`~ ${port} → 将停止 PID ${pid}`))
      continue
    }
    await terminate(pid)
    console.log(colors.green(`✓ ${port} → 已停止 PID ${pid}`))
  }

  if (!dryRun && (await waitPortFree(port))) {
    console.log(colors.dim(`  端口 ${port} 已释放`))
  } else if (!dryRun) {
    console.log(colors.red(`  端口 ${port} 仍被占用`))
    failed += 1
  }
}

process.exit(failed > 0 ? 1 : 0)
