import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { shellQuote } from '../exec/env.js'

/** 一条命令的执行结果（初始化阶段只关心成败与输出尾巴） */
export interface SetupExecResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

/**
 * 初始化阶段对工作区的**最小 IO 端口**：执行命令 + 读写文件。
 *
 * 为什么不用 runtime 的 `fs`：凭据要写到 `~/.config/...`（工作区目录之外），
 * 而 `fs` 端口被限制在工作区内。统一走 shell 命令，container / local 两种后端都能用，
 * 不必为初始化再造一套 fs 语义。
 */
export interface SetupShell {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<SetupExecResult>
  /**
   * 写文件（自动建父目录；默认 `0o600` —— 凭据文件必须只有执行用户可读）。
   *
   * `mode` 是**权限位值**（八进制字面量 `0o600`），不是十进制数字：
   * 旧约定让调用方传十进制 `600`，host 后端 `chmod(file, 600)` 会写成 `0o1130`（---x-wx--T），
   * 连属主都读不了（issue 6）。exec 后端用 `mode.toString(8)` 生成 `chmod 600`，两边语义一致。
   */
  write(path: string, content: string, mode?: number): Promise<void>
  /**
   * 批量写（物化技能用）：容器后端尽量合并成极少数命令，避免每个文件 2–4 次 `docker exec`。
   *
   * 失败时抛错即可 —— 调用方（`materializeSkills`）会退回逐个写，精确到文件记 partial。
   */
  writeMany(files: { path: string; content: string }[], mode?: number): Promise<void>
  /** 读文件；不存在返回 null */
  read(path: string): Promise<string | null>
  /** 列某个目录下的子目录名（技能收敛用；不依赖 shell，Windows 也能跑） */
  listDirs(path: string): Promise<string[]>
}

/** `~/x` / `x` → 可直接拼进 shell 的路径；`~` 必须交给 shell 展开，不能用引号包住 */
const shellPath = (path: string): string => {
  if (path === '~') return '"$HOME"'
  if (path.startsWith('~/')) {
    const rest = path.slice(2)
    return `"$HOME"/${shellQuote(rest)}`
  }
  return shellQuote(path)
}

const base64Of = (content: string): string => Buffer.from(content, 'utf8').toString('base64')

/**
 * 单条命令里 base64 的分片长度（4 的倍数：每片独立解码仍按 3 字节对齐）。
 *
 * **为什么必须分片**：内容 base64 后是作为 `printf` 的参数传进去的，Linux 对单条 argv
 * 有 128KB 上限（`MAX_ARG_STRLEN`），超过直接 `argument list too long`，命令不会执行。
 * 大文件（如 360KB 的素材、1MB 的脚本）因此会整条失败；而一个文件失败就会带走整个技能
 * （2026-11-22 实测：`design-taste-frontend` 只落了 52 个素材，`SKILL.md` 始终没写上）。
 * 48KB 留足余量，且每个分片单独一条 `exec`——拼成一条长命令同样会撞上限。
 */
const WRITE_CHUNK_CHARS = 48_000

/**
 * 用 `exec` 实现出 `SetupShell`（container / local 都适用）。
 *
 * 写文件走 `base64 -d`：内容里有引号、换行、`$` 时直接 heredoc 会被 shell 解释，
 * base64 之后只剩 `A-Za-z0-9+/=`，不存在注入面。
 */
export const createExecShell = (
  exec: (command: string, opts?: { timeoutMs?: number }) => Promise<SetupExecResult>,
): SetupShell => {
  /** 单个文件的写命令（内容 base64 后作为 printf 参数，无注入面） */
  const writeCommandOf = (path: string, content: string, mode: number): string => {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'
    const target = shellPath(path)
    const pieces = [`mkdir -p ${shellPath(dir)}`, `: > ${target}`]
    const base64 = base64Of(content)
    if (base64) pieces.push(`printf %s ${shellQuote(base64)} | base64 -d >> ${target}`)
    pieces.push(`chmod ${mode.toString(8)} ${target}`)
    return pieces.join(' && ')
  }

  const write = async (path: string, content: string, mode = 0o600): Promise<void> => {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'
    const target = shellPath(path)
    // 先建目录并截断（空文件也要真的落下来），再逐片追加，最后改权限
    const prepared = await exec(`mkdir -p ${shellPath(dir)} && : > ${target}`, {
      timeoutMs: 15_000,
    })
    if (!prepared.ok) throw new Error(`写文件失败（${path}）：${prepared.stderr.slice(0, 300)}`)

    const base64 = base64Of(content)
    for (let offset = 0; offset < base64.length; offset += WRITE_CHUNK_CHARS) {
      const chunk = base64.slice(offset, offset + WRITE_CHUNK_CHARS)
      const result = await exec(`printf %s ${shellQuote(chunk)} | base64 -d >> ${target}`, {
        timeoutMs: 15_000,
      })
      if (!result.ok) throw new Error(`写文件失败（${path}）：${result.stderr.slice(0, 300)}`)
    }

    const chmod = await exec(`chmod ${mode.toString(8)} ${target}`, { timeoutMs: 15_000 })
    if (!chmod.ok) throw new Error(`写文件失败（${path}）：${chmod.stderr.slice(0, 300)}`)
  }

  return {
    exec,
    write,

    async writeMany(files, mode = 0o600) {
      // 超片文件（base64 > 48KB）退回 write 的分片路径；其余按总命令长度分批
      const oversized: { path: string; content: string }[] = []
      let batch: string[] = []
      let chars = 0
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return
        const result = await exec(batch.join(' && '), { timeoutMs: 60_000 })
        batch = []
        chars = 0
        if (!result.ok) throw new Error(`批量写文件失败：${result.stderr.slice(0, 300)}`)
      }

      for (const file of files) {
        if (base64Of(file.content).length > WRITE_CHUNK_CHARS) {
          oversized.push(file)
          continue
        }
        const command = writeCommandOf(file.path, file.content, mode)
        if (chars + command.length > WRITE_CHUNK_CHARS && batch.length > 0) await flush()
        batch.push(command)
        chars += command.length + 4
      }
      await flush()
      for (const file of oversized) await write(file.path, file.content, mode)
    },

    async listDirs(path) {
      const result = await exec(`ls -1p ${shellPath(path)} 2>/dev/null || true`, {
        timeoutMs: 15_000,
      })
      return result.ok
        ? result.stdout
            .split('\n')
            .map((line) => line.trim().replace(/\/+$/, ''))
            .filter(Boolean)
        : []
    },

    async read(path) {
      // 用哨兵区分"文件不存在"与"文件为空"
      const result = await exec(
        `if [ -f ${shellPath(path)} ]; then cat ${shellPath(path)}; else echo __MISSING__; fi`,
        {
          timeoutMs: 15_000,
        },
      )
      if (!result.ok) return null
      return result.stdout === '__MISSING__\n' || result.stdout === '__MISSING__'
        ? null
        : result.stdout
    },
  }
}

/** Host 初始化 IO 的边界选项 */
export interface HostShellOptions {
  /** 是否允许落到宿主 HOME（凭据注入）；Host + 沙箱默认不写 */
  allowHome?: boolean
  /** 宿主 HOME（测试可注入；默认 `os.homedir()`） */
  home?: string
}

/**
 * **Host 后端的初始化 IO**：文件用 Node fs 直写，命令仍然走执行面。
 *
 * 为什么不像容器那样全走 shell：Windows 上没有 `mkdir -p` / `printf | base64 -d` / `chmod`，
 * 而 Host 的初始化只需要「写文件 + 跑命令」两件事，写文件直接用 Node fs 就没有平台依赖了。
 *
 * 三条纪律：
 * 1. **`~` 与 exec shell 同语义**：都指**真实 HOME**，不能落到 `{工作区}/~`（issue 6 的凭据静默失效）；
 * 2. **HOME 下不覆盖已有文件**：用户自己的 CLI 登录态不能被平台初始化冲掉；
 * 3. **越界安全**：工作区内恒允许；HOME 需 `allowHome`；其余读返回 null / 空列表，写直接报错。
 */
export const createHostShell = (
  root: string,
  exec: SetupShell['exec'],
  options: HostShellOptions = {},
): SetupShell => {
  const home = options.home ?? homedir()

  const expand = (path: string): string => {
    if (path === '~') return home
    if (path.startsWith('~/')) return resolve(home, path.slice(2))
    return isAbsolute(path) ? path : resolve(root, path)
  }

  /** 解析并做边界校验：工作区内恒允许；HOME 需 allowHome；其余 null */
  const resolveTarget = (path: string): { file: string; home: boolean } | null => {
    const resolved = resolve(expand(path))
    const rel = relative(root, resolved)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      return { file: resolved, home: false }
    }
    const relHome = relative(home, resolved)
    if (
      options.allowHome &&
      (relHome === '' || (!relHome.startsWith('..') && !isAbsolute(relHome)))
    ) {
      return { file: resolved, home: true }
    }
    return null
  }

  const requireTarget = (path: string): { file: string; home: boolean } => {
    const found = resolveTarget(path)
    if (!found) throw new Error(`初始化只允许写工作区内：${path}`)
    return found
  }

  const exists = async (file: string): Promise<boolean> =>
    stat(file)
      .then(() => true)
      .catch(() => false)

  const write = async (path: string, content: string, mode = 0o600): Promise<void> => {
    const { file, home: inHome } = requireTarget(path)
    // HOME 下已有文件不覆盖：保护用户自己的 CLI 登录态
    if (inHome && (await exists(file))) return
    const tmp = `${file}.billy-tmp-${randomBytes(4).toString('hex')}`
    await mkdir(dirname(file), { recursive: true })
    try {
      await writeFile(tmp, content, 'utf8')
      await rename(tmp, file)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
    // Windows 上 chmod 基本无效（只影响只读位），失败不报错
    await chmod(file, mode).catch(() => undefined)
  }

  return {
    exec,
    write,
    async writeMany(files, mode = 0o600) {
      for (const file of files) await write(file.path, file.content, mode)
    },
    async listDirs(path) {
      const found = resolveTarget(path)
      if (!found) return []
      return readdir(found.file, { withFileTypes: true })
        .then((entries) =>
          entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
        )
        .catch(() => [])
    },
    async read(path) {
      const found = resolveTarget(path)
      if (!found) return null
      return readFile(found.file, 'utf8').catch(() => null)
    },
  }
}
