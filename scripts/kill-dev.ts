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
 * 平台差异（Windows 上判定方式不同，务必读完再用）：
 *   - macOS / Linux：读进程 cwd（lsof），cwd 在本仓库内才动它 —— 判定最准。
 *   - Windows：拿不到 cwd（Win32_Process 没有这个字段），退化为「命令行里出现仓库路径」。
 *     进程表由 CIM 的 Win32_Process 取（CommandLine + ParentProcessId），监听端口由 netstat 取，
 *     端口只用于展示与收尾自检、**不作为杀的依据**，否则会把别的项目的 dev server 一起干掉。
 *     后遗症：next-server 这类标题被改写、命令行里不含路径的进程，靠「是某个命中进程的子孙」
 *     连坐清理；若其父进程已先退出（孤儿），会漏掉 —— 用 --dry-run 自查。
 *
 * 用法：
 *   pnpm kill:dev              停掉全部（生产 start 起的服务用 `pnpm kill:start`）
 *   pnpm kill:dev --dry-run    只列出将被停止的进程（-n 同义）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import colors from 'picocolors'

const IS_WIN = process.platform === 'win32'

/** 本仓库根目录（脚本位于 <root>/scripts/kill-dev.ts）；Windows 下是反斜杠路径，两种形态都要备着 */
const workspaceRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')

/** 判定用的小写变体：Windows 路径大小写不敏感，命令行里 / 与 \ 都可能出现 */
const rootVariants = IS_WIN
  ? [workspaceRoot.toLowerCase(), workspaceRoot.replaceAll('\\', '/').toLowerCase()]
  : [workspaceRoot]

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run') || args.includes('-n')
/** 连「疑似」（命中 dev 命令但确认不了属于本仓库）的一起清理；误杀风险自负 */
const loose = args.includes('--loose')

if (args.includes('--help') || args.includes('-h')) {
  console.log(`用法：pnpm kill:dev [--dry-run] [--loose]

  --dry-run, -n  只列出会被停止的进程，不做任何终止
  --loose        连命令行里没有仓库路径、确认不了归属的疑似 dev 进程一起清理
                 （Windows 上没有 cwd 可查时它们是漏网之鱼，但也可能属于别的仓库）
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
  /** 相对仓库根的工作目录（便于确认没有误伤）；Windows 下是从命令行猜的位置片段 */
  cwd: string
  /** 该进程监听的端口（可能为空） */
  ports: number[]
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
      // 进程表 / netstat 输出可能远超默认的 1MB，超了会 ENOBUFS 并被下面的 catch 吞成「没有 dev 服务」
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    })
  } catch {
    return ''
  }
}

/**
 * Windows 下取进程表：只能靠 CIM（Win32_Process 才有 CommandLine）。
 * 分隔符用制表符（命令行里几乎不会出现），并把换行压平，保证一行一个进程。
 */
const PS_LIST_PROCESSES = [
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
  'Get-CimInstance Win32_Process | ForEach-Object {',
  '$_.ProcessId.ToString() + "`t" + $_.ParentProcessId.ToString() + "`t" +',
  '($_.CommandLine -replace "[\\r\\n\\t]+", " ")',
  '}',
].join(' ')

function listProcessesWin(): ProcessInfo[] {
  const processes: ProcessInfo[] = []
  const output = run('powershell.exe', ['-NoProfile', '-Command', PS_LIST_PROCESSES])

  for (const line of output.split('\n')) {
    const columns = line.trim().split('\t')
    if (columns.length < 2 || !/^\d+$/.test(columns[0] ?? '')) continue

    processes.push({
      pid: Number(columns[0]),
      ppid: Number(columns[1] ?? 0),
      command: columns.slice(2).join(' ') || '(unknown)',
    })
  }

  return processes
}

function listProcesses(): ProcessInfo[] {
  if (IS_WIN) return listProcessesWin()

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

/** Windows：netstat -ano 的 LISTENING 行，形如 `TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  12345` */
function listListenersWin(): Array<{ pid: number; port: number }> {
  const listeners: Array<{ pid: number; port: number }> = []

  for (const line of run('netstat.exe', ['-ano', '-p', 'TCP']).split('\n')) {
    const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
    if (!match) continue

    const pid = Number(match[3] ?? 0)
    const port = Number(match[2] ?? 0)
    if (!pid || !port) continue

    listeners.push({ pid, port })
  }

  return listeners
}

/** 本机所有 TCP LISTEN 的 (pid, port)；用整行正则取地址列，兼容 IPv4/IPv6 与 (LISTEN) 状态后缀 */
function listListeners(): Array<{ pid: number; port: number }> {
  if (IS_WIN) return listListenersWin()

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

/** pid → 它监听的端口（两个平台都填，只用于展示与收尾自检） */
const listenPorts = new Map<number, number[]>()

/**
 * Windows 没有 cwd 可查，只能从命令行里出现的仓库路径后面截一段当位置（显示用，方便人工核对）。
 * 返回 null 表示命令行里完全没有仓库路径 —— 一律不杀。
 */
function guessWorkspacePath(command: string): string | null {
  const lower = command.toLowerCase()

  for (const variant of rootVariants) {
    const index = lower.indexOf(variant)
    if (index < 0) continue

    const rest = command.slice(index + variant.length).replace(/^[\\/]+/, '')
    const token = rest.split(/[\s"']/)[0] ?? ''
    const segments = token.split(/[\\/]/).filter(Boolean).slice(0, 2)

    return segments.length > 0 ? segments.join('/') : '.'
  }

  return null
}

/**
 * 本仓库的「已知 dev 端口」：apps/* 的 dev 脚本里的 --port / -p，加上 .env 里的 PORT。
 * Windows 上没有 cwd，命令行又是相对路径时（admin 的 `./node_modules/.bin/next dev --port 9845`、
 * server 的 `node --watch --import tsx/esm src/main.ts`），监听这些端口就是第二条归属证据 ——
 * 别的仓库几乎不可能撞上 9840 这种端口。
 */
function scanDevPorts(): Set<number> {
  const ports = new Set<number>()
  const add = (value: number): void => {
    if (value > 1024 && value < 65536) ports.add(value)
  }

  const readJson = (file: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  const subDirs = (base: string): string[] => {
    try {
      return readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
        .map((entry) => join(base, entry.name))
    } catch {
      return []
    }
  }

  const scanEnv = (file: string): void => {
    if (!existsSync(file)) return
    try {
      for (const match of readFileSync(file, 'utf8').matchAll(/^\s*PORT\s*=\s*(\d+)\s*$/gm)) {
        add(Number(match[1] ?? 0))
      }
    } catch {
      /* 读不到就算了 */
    }
  }

  for (const dir of [
    ...subDirs(join(workspaceRoot, 'apps')),
    ...subDirs(join(workspaceRoot, 'packages')),
    workspaceRoot,
  ]) {
    const scripts = readJson(join(dir, 'package.json')).scripts
    if (scripts && typeof scripts === 'object') {
      for (const script of Object.values(scripts as Record<string, unknown>)) {
        if (typeof script !== 'string') continue
        for (const match of script.matchAll(/--port[=\s]+(\d+)|\s-p[=\s]+(\d+)/g)) {
          add(Number(match[1] ?? match[2] ?? 0))
        }
      }
    }

    for (const name of ['.env', '.env.local', '.env.example']) scanEnv(join(dir, name))
  }

  return ports
}

let cachedDevPorts: Set<number> | null = null
const devPorts = (): Set<number> => (cachedDevPorts ??= scanDevPorts())

/**
 * 判定「这个进程属不属于本仓库」，返回用于展示的位置描述；不属于返回 null（宁可漏杀不可误杀）。
 * POSIX 看 cwd；Windows 先看命令行里的仓库路径，再看它监听的是不是本仓库的 dev 端口。
 */
function locate(process_: ProcessInfo, getCwd: (pid: number) => string | null): string | null {
  if (IS_WIN) {
    const place = guessWorkspacePath(process_.command)
    if (place !== null) return place

    const port = (listenPorts.get(process_.pid) ?? [])[0]
    return port !== undefined && devPorts().has(port) ? `(端口 ${port})` : null
  }

  const cwd = getCwd(process_.pid)
  return cwd !== null && isInsideWorkspace(cwd) ? relativeCwd(cwd) : null
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

function collectTargets(loose: boolean): { targets: Target[]; suspects: ProcessInfo[] } {
  const processes = listProcesses()
  const excluded = ownAncestors(processes)
  const cwdCache = new Map<number, string | null>()

  const getCwd = (pid: number): string | null => {
    if (!cwdCache.has(pid)) cwdCache.set(pid, readCwd(pid))
    return cwdCache.get(pid) ?? null
  }

  const targets = new Map<number, Target>()
  const suspects: ProcessInfo[] = []
  listenPorts.clear()

  /** force=true 时跳过归属判定（--loose） */
  const add = (process_: ProcessInfo, reason: string, force = false): void => {
    if (excluded.has(process_.pid) || process_.pid <= 1) return
    if (targets.has(process_.pid)) return

    const place = locate(process_, getCwd)
    if (place === null && !force) return

    targets.set(process_.pid, {
      ...process_,
      reason,
      cwd: place ?? '(归属未确认)',
      ports: listenPorts.get(process_.pid) ?? [],
    })
  }

  const byPid = new Map(processes.map((item) => [item.pid, item]))

  // ① 监听端口的进程（覆盖进程标题被改写的 next-server 等）
  //    Windows 上端口原则上不构成证据（拿不到 cwd），只有监听「本仓库已知 dev 端口」的才算 ——
  //    否则会把别的项目的 dev server 一起干掉。
  for (const listener of listListeners()) {
    const ports = listenPorts.get(listener.pid) ?? []
    ports.push(listener.port)
    listenPorts.set(listener.pid, ports)

    if (IS_WIN && !devPorts().has(listener.port)) continue
    const process_ = byPid.get(listener.pid)
    if (process_) add(process_, `监听 ${listener.port}`)
  }

  // ② 命中 dev 命令的进程（覆盖不监听端口的 watcher，如 turbo / tsdown / pnpm 包装进程）
  //    判定不出归属的（命令行里没有仓库路径）记为「疑似」：默认不杀，只提示；--loose 才收进来
  for (const process_ of processes) {
    const hit = DEV_COMMAND_PATTERNS.find(([, pattern]) => pattern.test(process_.command))
    if (!hit) continue

    if (loose) {
      add(process_, hit[0], true)
      continue
    }

    const known = targets.has(process_.pid)
    add(process_, hit[0])
    if (!known && !targets.has(process_.pid) && !excluded.has(process_.pid) && process_.pid > 1) {
      suspects.push(process_)
    }
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
        ports: listenPorts.get(childPid) ?? [],
      })
      queue.push(childPid)
    }
  }

  // ④ 同源兜底（仅 Windows 有意义）：`node --watch` 这类 supervisor 在 Windows 上 fork 出的子进程，
  //    PPID 常指向一个已经退出的中间进程，父子链是断的 —— 只杀子进程的话 supervisor 会立刻把它拉起来，
  //    等于没杀。用「去掉 --watch 后命令行一致」把两边绑到一起；只作用于确认不了归属的疑似进程。
  if (!loose && IS_WIN) {
    const normalize = (command: string): string =>
      command
        .replace(/--watch\b/g, '')
        .replace(/\.exe\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()

    const keys = Array.from(targets.values(), (item) => normalize(item.command)).filter(
      (key) => key.length >= 15,
    )
    const reason = (process_: ProcessInfo): string =>
      DEV_COMMAND_PATTERNS.find(([, pattern]) => pattern.test(process_.command))?.[0] ?? 'dev 命令'

    for (const suspect of suspects) {
      const key = normalize(suspect.command)
      if (key.length < 15) continue
      if (!keys.some((other) => other === key || other.includes(key) || key.includes(other)))
        continue

      targets.set(suspect.pid, {
        ...suspect,
        reason: `${reason(suspect)}（同源）`,
        cwd: '(同源)',
        ports: listenPorts.get(suspect.pid) ?? [],
      })
    }
  }

  // ⑤ 向上收包装链：pnpm run dev → cmd /c → turbo run dev 这种，父进程命令行里往往没有仓库路径。
  //    只收「自己也命中 dev 命令特征」的祖先，不匹配特征的祖先（终端 / shell）一律不动 ——
  //    否则会把用户跑 dev 的那个终端整个端掉。
  if (!loose) {
    const suspectByPid = new Map(suspects.map((item) => [item.pid, item]))

    // 快照初始目标：循环里会补入包装进程，不能边遍历边扩展
    for (const pid of Array.from(targets.keys())) {
      let current = byPid.get(pid)

      while (current && current.ppid > 1) {
        if (targets.has(current.ppid)) break

        const parent = suspectByPid.get(current.ppid)
        if (!parent) break

        const reason = DEV_COMMAND_PATTERNS.find(([, pattern]) => pattern.test(parent.command))?.[0]
        targets.set(parent.pid, {
          ...parent,
          reason: `${reason ?? 'dev 命令'}（包装进程）`,
          cwd: '(包装进程)',
          ports: listenPorts.get(parent.pid) ?? [],
        })

        current = byPid.get(current.ppid)
      }
    }
  }

  return {
    targets: Array.from(targets.values()),
    suspects: suspects.filter((item) => !targets.has(item.pid)),
  }
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

    const target = targets.find((item) => item.pid === pid)
    for (const port of target?.ports ?? []) ports.add(String(port))
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
  if (IS_WIN) {
    const pattern = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s`, 'im')
    return pattern.test(run('netstat.exe', ['-ano', '-p', 'TCP']))
  }

  return run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).trim() !== ''
}

/** 存活判定：僵尸进程（stat 以 Z 开头）已无实际进程，只在等待父进程回收，不算存活 */
function isAlive(pid: number): boolean {
  // Windows 没有 stat 可查：signal 0 只做存在性探测（OpenProcess），拿不到句柄即视为已退出
  if (IS_WIN) return signal(pid, 0)

  const stat = run('ps', ['-o', 'stat=', '-p', String(pid)]).trim()
  return stat !== '' && !stat.startsWith('Z')
}

/** Windows：taskkill /T 连子孙一起收，/F 强制（控制台进程拿不到 WM_CLOSE，不带 /F 基本杀不掉） */
function killTreeWin(pid: number): void {
  run('taskkill.exe', ['/PID', String(pid), '/T', '/F'])
}

function signal(pid: number, signalName: NodeJS.Signals | number): boolean {
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
  const { targets, suspects } = collectTargets(loose)

  console.log(colors.bold(colors.cyan('\nBilly dev 服务清理')))
  console.log(colors.dim(`工作目录：${workspaceRoot}\n`))
  if (IS_WIN) {
    console.log(
      colors.dim('Windows 模式：拿不到 cwd，按命令行里的仓库路径 + 本仓库已知 dev 端口判定。\n'),
    )
  }

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
  console.log(colors.dim(`\n命中 ${targets.length} 个进程（含子孙进程），监听端口不会残留。`))

  // 归属确认不了的：宁可漏杀不可误杀，但必须让人看见漏了什么
  if (suspects.length > 0) {
    console.log(
      colors.yellow(
        `\n⚠ 另有 ${suspects.length} 个疑似 dev 进程确认不了归属（命令行里没有仓库路径），已跳过：`,
      ),
    )
    for (const suspect of suspects.slice(0, 8)) {
      console.log(
        colors.dim(`  pid ${String(suspect.pid).padEnd(7)} ${prettyCommand(suspect.command)}`),
      )
    }
    if (suspects.length > 8) console.log(colors.dim(`  … 还有 ${suspects.length - 8} 个`))
    console.log(colors.dim('  确认它们都是本仓库的，用 pnpm kill:dev --loose 一起清理。'))
  }

  if (dryRun) {
    console.log(colors.cyan('\n--dry-run：仅预览，未做任何终止。'))
    return
  }

  const ordered = sortByDepthDesc(targets)
  let survivors: Target[]

  if (IS_WIN) {
    // Windows 没有优雅退出（SIGTERM 落到 TerminateProcess），直接对最外层收整棵树
    console.log(colors.cyan('\n正在停止（taskkill /T /F）…'))
    for (const target of topLevelTargets(targets)) killTreeWin(target.pid)
    await sleep(400)
    survivors = ordered.filter((target) => isAlive(target.pid))
  } else {
    console.log(colors.cyan('\n正在停止（SIGTERM）…'))
    for (const target of ordered) signal(target.pid, 'SIGTERM')

    const deadline = Date.now() + TERM_GRACE_MS
    survivors = ordered.filter((target) => isAlive(target.pid))
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
  }

  const stoppedPorts = [...new Set(targets.flatMap((target) => target.ports))].map((port) =>
    String(port),
  )

  if (survivors.length === 0) {
    const occupied = stoppedPorts.filter((port) => portStillListening(port))
    console.log(
      colors.green(
        `\n✔ 已停止 ${targets.length} 个进程${stoppedPorts.length > 0 ? `，端口 ${stoppedPorts.join(' / ')} 已释放` : ''}。`,
      ),
    )
    if (occupied.length > 0) {
      console.log(
        colors.yellow(`⚠ 端口 ${occupied.join(' / ')} 仍在监听，可能有脚本外的残留进程。`),
      )
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
