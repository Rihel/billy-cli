import { isAbsolute, relative } from 'node:path'

/**
 * 目标是否等于 `root` 或位于 `root` 之下（纯字符串判断，入参须已是绝对路径）。
 *
 * 宿主与容器两侧共用同一套判断：容器侧是 `startsWith` 的替代（它会把 `/workspace-evil` 当成区内）。
 */
export const isInside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
