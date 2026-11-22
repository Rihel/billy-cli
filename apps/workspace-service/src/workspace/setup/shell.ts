import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
  /** 写文件（自动建父目录；默认 600 权限 —— 凭据文件必须只有执行用户可读） */
  write(path: string, content: string, mode?: number): Promise<void>
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
): SetupShell => ({
  exec,

  async write(path, content, mode = 600) {
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

    const chmod = await exec(`chmod ${mode} ${target}`, { timeoutMs: 15_000 })
    if (!chmod.ok) throw new Error(`写文件失败（${path}）：${chmod.stderr.slice(0, 300)}`)
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
})

/**
 * **Host 后端的初始化 IO**：文件用 Node fs 直写，命令仍然走执行面。
 *
 * 为什么不像容器那样全走 shell：Windows 上没有 `mkdir -p` / `printf | base64 -d` / `chmod`，
 * 而 Host 的初始化只需要「写文件 + 跑命令」两件事，写文件直接用 Node fs 就没有平台依赖了。
 *
 * 两条纪律：
 * 1. **只写工作区内**：Host 的初始化只落技能与标记（凭据与安装清单已按声明跳过），
 *    路径越界直接报错，不因为「能写宿主」就放开；
 * 2. **原子写**：同目录临时文件 + `rename`，与文件能力保持同一套语义。
 */
export const createHostShell = (root: string, exec: SetupShell['exec']): SetupShell => {
  const target = (path: string): string => {
    const resolved = isAbsolute(path) ? resolve(path) : resolve(root, path)
    const rel = relative(root, resolved)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`初始化只允许写工作区内：${path}`)
    }
    return resolved
  }

  return {
    exec,

    async write(path, content, mode = 600) {
      const file = target(path)
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
    },

    async listDirs(path) {
      return readdir(target(path), { withFileTypes: true })
        .then((entries) =>
          entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
        )
        .catch(() => [])
    },

    async read(path) {
      return readFile(target(path), 'utf8').catch(() => null)
    },
  }
}
