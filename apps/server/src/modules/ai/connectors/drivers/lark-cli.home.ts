import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * **把 CLI 的 HOME 目录在「磁盘 ↔ 库」之间来回搬**（纯函数，便于单测）。
 *
 * 背景：lark-cli 把 app 配置与用户 token 存在 HOME 里；pod 无状态、不挂 PVC，
 * 所以每次调用前从库恢复到临时 HOME，调用后 diff 写回。这里只做文件层面的搬运，
 * 不认识 CLI 的具体格式。
 *
 * 四条边界：
 * - 单文件 ≤ 256KB、总量 ≤ 2MB：token / 配置都很小，超了的是缓存，跳过；
 * - 跳过 `cache` / `tmp` / `logs` 目录：缓存可以重建，不必进库；
 * - 路径必须是 HOME 内的相对路径：防 `../` 越界写；
 * - 恢复时清空目录再写、文件 0600、目录 0700：沿用 CLI 自己的权限口径。
 */

/** 单个文件入向上限（超过视为缓存 / 二进制，跳过） */
export const MAX_FILE_BYTES = 256 * 1024
/** 整份快照上限 */
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024

const SKIP_DIRS = new Set(['cache', 'tmp', 'logs'])

/** 读 HOME → `{ 相对路径: base64 }` */
export const snapshotHome = async (dir: string): Promise<Record<string, string>> => {
  const files: Record<string, string> = {}
  let total = 0

  const walk = async (current: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full, rel)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(full).catch(() => null)
      if (!info || info.size > MAX_FILE_BYTES) continue
      if (total + info.size > MAX_TOTAL_BYTES) continue
      const data = await readFile(full).catch(() => null)
      if (!data) continue
      files[rel] = data.toString('base64')
      total += data.length
    }
  }

  await walk(dir, '')
  return files
}

/** 把 `{ 相对路径: base64 }` 写回 HOME（**先清空**，保证与库里一致） */
export const restoreHome = async (dir: string, files: Record<string, string>): Promise<void> => {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true, mode: 0o700 })
  for (const [rel, base64] of Object.entries(files)) {
    if (!isSafeRelative(rel)) continue
    const target = join(dir, rel)
    const check = relative(dir, target)
    if (!check || check.startsWith('..') || isAbsolute(check)) continue
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, Buffer.from(base64, 'base64'), { mode: 0o600 })
  }
}

/** 两份快照是否相同（键排序后再比，避免 readdir 顺序造成误判） */
export const sameFiles = (
  a: Record<string, string> | null,
  b: Record<string, string> | null,
): boolean => canonical(a) === canonical(b)

const canonical = (files: Record<string, string> | null): string => {
  if (!files) return ''
  return JSON.stringify(
    Object.keys(files)
      .sort()
      .map((key) => [key, files[key]]),
  )
}

/** 只接受 HOME 内的相对路径：拒绝绝对路径、`..`、Windows 分隔符 */
const isSafeRelative = (rel: string): boolean => {
  if (!rel || isAbsolute(rel)) return false
  if (rel.includes(sep + '..') || rel.startsWith('..')) return false
  if (rel.includes('\\') || rel.includes('\0')) return false
  return true
}
