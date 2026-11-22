const isSafeDirName = (name: string): boolean => /^[A-Za-z0-9._-]+$/.test(name)

/**
 * 一次 `find` 取回整棵树（容器后端）。
 *
 * `-printf '%P\t%s\t%T@\n'`：相对路径、字节数、mtime（秒.毫秒），
 * 避免每个文件一次 `docker exec`（实测 1500 个文件要 58 秒）。
 */
export const buildFindTreeCommand = (
  target: string,
  maxDepth: number,
  excludeDirs: readonly string[],
): string => {
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
  const names = excludeDirs.filter(isSafeDirName)
  // 不用 `\( … \)` 分组：容器里是 dash（sh），反斜杠在字符串里还要再转义一层，极易写错；
  // `-not -path '*/NAME/*'` 没有括号、无需分组，语义也更直白。
  const excludes = names.map((name) => `-not -path ${quote(`*/${name}/*`)}`).join(' ')
  return `find ${quote(target)} -maxdepth ${Math.max(1, Math.floor(maxDepth))} -type f ${excludes} -printf '%P\\t%s\\t%T@\\n'`
}

/** 解析 `find -printf` 的输出（容器与测试共用；坏行直接跳过，不整体失败） */
export const parseFindTree = (stdout: string): { path: string; size: number; mtime: number }[] =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [rawPath, rawSize, rawMtime] = line.split('\t')
      if (!rawPath || !rawSize) return []
      const size = Number(rawSize)
      const seconds = Number(rawMtime)
      if (!Number.isFinite(size) || !Number.isFinite(seconds)) return []
      return [{ path: rawPath, size, mtime: Math.round(seconds * 1000) }]
    })
