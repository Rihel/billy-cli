/**
 * 一键干掉本仓库所有 dev 服务与 watcher。
 *
 * 为什么不用 `pkill -f`：宽泛的模式会误杀无关进程（历史事故：pkill 模式过宽，连带停掉了
 * 另一个终端里占用 9845 的 admin dev）。本脚本的判定条件是两个「与仓库强绑定」的条件之一：
 *   ① 工作目录在本仓库内，且命令命中已知 dev 命令（next dev / turbo dev / tsdown watch /
 *      node|tsx watch / pnpm run dev）；
 *   ② 工作目录在本仓库内，且正在监听 TCP 端口（覆盖进程标题被改写、命令匹配不到的 dev server）。
 * 命中后连带清理其子孙进程（先 SIGTERM，超时未退再 SIGKILL），并跳过脚本自身的进程祖先。
 *
 * 用法：
 *   pnpm kill:dev              停掉全部
 *   pnpm kill:dev --dry-run    只列出将被停止的进程（-n 同义）
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import colors from 'picocolors'

/** 本仓库根目录（脚本位于 <root>/scripts/kill-dev.ts） */
const workspaceRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run') || args.includes('-n')

if (args.includes('--help') || args.includes('-h')) {
  console.log(`用法：pnpm kill:dev [--dry-run]

  --dry-run, -n  只列出会被停止的进程，不做任何终止
`)
  process.exit(0)
}

/** dev 进程的命令行特征（先命中候选，再用工作目录二次确认） */
const DEV_COMMAND_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['turbo dev', /\bturbo(?:\.js)?\b[^\n]*\brun\s+dev\b/],
  ['next dev', /\bnext(?:-server)?\s+dev\b/],
  ['tsdown watch', /\btsdown\b[^\n]*\bwatch\b/],
  ['node/tsx watch', /\b(?:node|tsx)\b[^\n]*\bwatch\b/],
  ['pnpm run dev', /\bpnpm(?:\.js)?\b[^\n]*\brun\s+dev\b/],
]

/** SIGTERM 后等待优雅退出的时长（毫秒），超时用 SIGKILL */
const TERM_GRACE_MS = 2000

type ProcessInfo = {
  pid: number
  ppid: number
  command: string
}

type Target = ProcessInfo & {
  /** 命中的原因，用于输出（如「监听 9840」「next dev」） */
  reason: string
  /** 相对仓库根的工作目录（便于确认没有误伤） */
  cwd: string
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** 执行命令并取 stdout；失败（如 lsof 无结果）时按空结果处理 */
function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

function listProcesses(): ProcessInfo[] {
  const processes: ProcessInfo[] = []

  for (const line of run('ps', ['-eo', 'pid=,ppid=,command=']).split('\n')) {
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line.trim())
    if (!match) continue

    processes.push({
      pid: Number(match[1] ?? 0),
      ppid: Number(match[2] ?? 0),
      command: match[3] ?? '',
    })
  }

  return processes
}

/** 读取进程工作目录（拿不到返回 null，此时一律不杀，宁可漏杀不可误杀） */
function readCwd(pid: number): string | null {
  for (const line of run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n')) {
    if (line.startsWith('n')) return line.slice(1)
  }
  return null
}

/** 本机所有 TCP LISTEN 的 (pid, port)；用整行正则取地址列，兼容 IPv4/IPv6 与 (LISTEN) 状态后缀 */
function listListeners(): Array<{ pid: number; port: number }> {
  const listeners: Array<{ pid: number; port: number }> = []

  for (const line of run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']).split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/)
    const pid = Number(columns[1] ?? 0)
    const port = /:(\d+)\s*(?:\(LISTEN\))?\s*$/.exec(line)
    if (!pid || !port) continue

    listeners.push({ pid, port: Number(port[1] ?? 0) })
  }

  return listeners
}

function isInsideWorkspace(targetPath: string): boolean {
  return targetPath === workspaceRoot || targetPath.startsWith(`${workspaceRoot}/`)
}

function relativeCwd(cwd: string): string {
  const relative = cwd.slice(workspaceRoot.length + 1)
  return relative || '.'
}

/** 脚本自身 + 其祖先链：绝不能杀（否则会波及运行本脚本的终端 / pnpm，甚至 harness） */
function ownAncestors(processes: ProcessInfo[]): Set<number> {
  const byPid = new Map(processes.map((item) => [item.pid, item]))
  const ancestors = new Set<number>([process.pid])

  let current = byPid.get(process.pid)
  while (current && current.ppid > 1) {
    ancestors.add(current.ppid)
    current = byPid.get(current.ppid)
  }

  return ancestors
}

function collectTargets(): Target[] {
  const processes = listProcesses()
  const excluded = ownAncestors(processes)
  const cwdCache = new Map<number, string | null>()

  const getCwd = (pid: number): string | null => {
    if (!cwdCache.has(pid)) cwdCache.set(pid, readCwd(pid))
    return cwdCache.get(pid) ?? null
  }

  const targets = new Map<number, Target>()

  const add = (process_: ProcessInfo, reason: string): void => {
    if (excluded.has(process_.pid) || process_.pid <= 1) return
    const cwd = getCwd(process_.pid)
    if (cwd === null || !isInsideWorkspace(cwd)) return
    if (targets.has(process_.pid)) return

    targets.set(process_.pid, { ...process_, reason, cwd: relativeCwd(cwd) })
  }

  const byPid = new Map(processes.map((item) => [item.pid, item]))

  // ① 监听端口的进程（覆盖进程标题被改写的 next-server 等）
  for (const listener of listListeners()) {
    const process_ = byPid.get(listener.pid)
    if (process_) add(process_, `监听 ${listener.port}`)
  }

  // ② 命中 dev 命令的进程（覆盖不监听端口的 watcher，如 turbo / tsdown / pnpm 包装进程）
  for (const process_ of processes) {
    const hit = DEV_COMMAND_PATTERNS.find(([, pattern]) => pattern.test(process_.command))
    if (hit) add(process_, hit[0])
  }

  // ③ 连带子孙进程（dev server 常有 父 pnpm → sh → next dev → worker 多层结构）
  const childrenOf = new Map<number, number[]>()
  for (const process_ of processes) {
    const children = childrenOf.get(process_.ppid) ?? []
    children.push(process_.pid)
    childrenOf.set(process_.ppid, children)
  }

  const queue = [...targets.keys()]
  while (queue.length > 0) {
    const pid = queue.shift()
    if (pid === undefined) continue

    for (const childPid of childrenOf.get(pid) ?? []) {
      if (excluded.has(childPid) || targets.has(childPid)) continue
      const process_ = byPid.get(childPid)
      if (!process_) continue

      const parent = targets.get(pid)
      targets.set(childPid, {
        ...process_,
        reason: parent ? `${parent.reason} 的子进程` : '子进程',
        cwd: parent?.cwd ?? '.',
      })
      queue.push(childPid)
    }
  }

  return [...targets.values()]
}

/** 只报最外层的目标（子孙进程顺带清理，不必逐条刷屏） */
function topLevelTargets(targets: Target[]): Target[] {
  const pids = new Set(targets.map((item) => item.pid))
  return targets.filter((item) => !pids.has(item.ppid))
}

/** 某个根目标的子孙里包含的监听端口（预览时一眼看清会释放哪些端口） */
function portsUnder(rootPid: number, targets: Target[]): string[] {
  const childrenOf = new Map<number, number[]>()
  for (const target of targets) {
    const children = childrenOf.get(target.ppid) ?? []
    children.push(target.pid)
    childrenOf.set(target.ppid, children)
  }

  const ports = new Set<string>()
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()
    if (pid === undefined) continue

    const port = /^监听 (\d+)$/.exec(targets.find((item) => item.pid === pid)?.reason ?? '')?.[1]
    if (port) ports.add(port)
    queue.push(...(childrenOf.get(pid) ?? []))
  }

  return [...ports]
}

/** 命令展示：折叠仓库前缀与超长路径，便于人工核对没杀错东西 */
function prettyCommand(command: string): string {
  return command
    .replaceAll(workspaceRoot, '.')
    .replace(/\S{42,}/g, (token) => `…/${token.slice(token.lastIndexOf('/') + 1)}`)
    .slice(0, 120)
}

/** 端口是否仍在监听（收尾自检，避免「以为杀了实际还占着」） */
function portStillListening(port: string): boolean {
  return run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).trim() !== ''
}

/** 存活判定：僵尸进程（stat 以 Z 开头）已无实际进程，只在等待父进程回收，不算存活 */
function isAlive(pid: number): boolean {
  const stat = run('ps', ['-o', 'stat=', '-p', String(pid)]).trim()
  return stat !== '' && !stat.startsWith('Z')
}

function signal(pid: number, signalName: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signalName)
    return true
  } catch {
    return false
  }
}

/** 按进程树深度倒序：先杀子孙，再杀父进程，避免父进程把子进程再拉起来 */
function sortByDepthDesc(targets: Target[]): Target[] {
  const parents = new Map(targets.map((item) => [item.pid, item.ppid]))

  const depthOf = (pid: number): number => {
    let depth = 0
    let current = parents.get(pid)
    while (current !== undefined && parents.has(current)) {
      depth += 1
      current = parents.get(current)
    }
    return depth
  }

  return [...targets].sort((a, b) => depthOf(b.pid) - depthOf(a.pid))
}

async function main(): Promise<void> {
  const targets = collectTargets()

  console.log(colors.bold(colors.cyan('\nBilly dev 服务清理')))
  console.log(colors.dim(`工作目录：${workspaceRoot}\n`))

  if (targets.length === 0) {
    console.log(colors.green('没有发现运行中的 dev 服务。'))
    return
  }

  for (const target of topLevelTargets(targets)) {
    const ports = portsUnder(target.pid, targets)
    const suffix = ports.length > 0 ? colors.green(`  端口 ${ports.join(' / ')}`) : ''
    console.log(
      `  ${colors.yellow('●')} ${colors.bold(target.reason.padEnd(16))} pid ${String(target.pid).padEnd(7)} ${colors.dim(target.cwd)}${suffix}`,
    )
    console.log(`    ${colors.dim(prettyCommand(target.command))}`)
  }
  console.log(
    colors.dim(
      `\n命中 ${targets.length} 个进程（含子孙进程），监听端口不会残留。`,
    ),
  )

  if (dryRun) {
    console.log(colors.cyan('\n--dry-run：仅预览，未做任何终止。'))
    return
  }

  const ordered = sortByDepthDesc(targets)
  console.log(colors.cyan('\n正在停止（SIGTERM）…'))
  for (const target of ordered) signal(target.pid, 'SIGTERM')

  const deadline = Date.now() + TERM_GRACE_MS
  let survivors = ordered.filter((target) => isAlive(target.pid))
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(100)
    survivors = survivors.filter((target) => isAlive(target.pid))
  }

  if (survivors.length > 0) {
    console.log(colors.yellow(`仍有 ${survivors.length} 个进程未退出，改用 SIGKILL…`))
    for (const target of survivors) signal(target.pid, 'SIGKILL')
    await sleep(300)
    survivors = survivors.filter((target) => isAlive(target.pid))
  }

  const stoppedPorts = [
    ...new Set(
      targets
        .map((target) => /^监听 (\d+)$/.exec(target.reason)?.[1])
        .filter((port): port is string => port !== undefined),
    ),
  ]

  if (survivors.length === 0) {
    const occupied = stoppedPorts.filter((port) => portStillListening(port))
    console.log(
      colors.green(
        `\n✔ 已停止 ${targets.length} 个进程${stoppedPorts.length > 0 ? `，端口 ${stoppedPorts.join(' / ')} 已释放` : ''}。`,
      ),
    )
    if (occupied.length > 0) {
      console.log(colors.yellow(`⚠ 端口 ${occupied.join(' / ')} 仍在监听，可能有脚本外的残留进程。`))
      process.exitCode = 1
    }
    return
  }

  console.log(colors.red(`\n✘ 有 ${survivors.length} 个进程未能停止，请手动处理：`))
  for (const target of survivors) {
    console.log(colors.red(`  pid ${target.pid}  ${target.command.slice(0, 110)}`))
  }
  process.exitCode = 1
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(colors.red(`\n清理失败：${message}`))
  process.exitCode = 1
})
