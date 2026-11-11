import { isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { realpath, stat } from 'node:fs/promises'
import { ToolDeniedError } from './tools.types.js'
import type { ToolEnvCaps } from './tools.types.js'

/**
 * **AI 会话工作区**（设计 `docs/design/ai-file-manager.md` §5）。
 *
 * 布局：`{workspaceRoot}/{conversationId}/`，`bash` 与文件工具共用同一个根。
 * 这里只做纯路径 / 文件系统判断，不碰数据库与对象存储。
 */

/** 未配置 `AGENT_COMMAND_WORK_DIR` 时的默认根（不再回落 `process.cwd()`） */
export const DEFAULT_WORKSPACE_ROOT = join(homedir(), '.billy', 'workspaces')

/** 工作区根：env（部署边界）优先，其次默认目录 */
export const workspaceRoot = (caps?: ToolEnvCaps): string => {
  const configured = caps?.command?.workDir?.trim()
  return resolve(configured || DEFAULT_WORKSPACE_ROOT)
}

/** 某会话的独立工作区（目录不一定存在；写之前调用方自行 mkdir） */
export const conversationWorkspace = (
  caps: ToolEnvCaps | undefined,
  conversationId: string | null | undefined,
): string => {
  const id = conversationId?.trim() || '_default'
  return resolve(workspaceRoot(caps), id)
}

const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 找到 target 最近的已存在祖先（target 自己存在就用它） */
const nearestExisting = async (target: string): Promise<string> => {
  let current = target
  for (;;) {
    try {
      await stat(current)
      return current
    } catch {
      const parent = resolve(current, '..')
      if (parent === current) return target
      current = parent
    }
  }
}

/**
 * 把模型给的路径解析成工作区内的绝对路径，并做**软链逃逸**判断。
 *
 * - 相对路径按会话工作区解析；绝对路径必须已经在工作区内；
 * - `path.relative` 处理 `..`，`realpath` 处理软链；两者都过才放行；
 * - `allowMissing`：写文件时目标可能不存在，对最近的已存在祖先做 realpath。
 */
export const resolveWorkspacePath = async (input: {
  caps?: ToolEnvCaps
  conversationId: string | null | undefined
  path: string
  allowMissing?: boolean
}): Promise<string> => {
  const root = conversationWorkspace(input.caps, input.conversationId)
  const raw = input.path?.trim() ?? ''
  if (!raw) throw new ToolDeniedError('invalid-input', '文件路径不能为空')
  const target = resolve(root, raw)
  if (!inside(root, target)) {
    throw new ToolDeniedError('invalid-input', `文件路径必须在本会话工作区内（${root}）`)
  }

  const probe = input.allowMissing ? await nearestExisting(target) : target
  let real: string
  try {
    real = await realpath(probe)
  } catch {
    throw new ToolDeniedError('invalid-input', `文件路径不存在：${input.path}`)
  }
  // 最近的已存在祖先必须在工作区根之内；根还没建时，以它的父目录（base）为界。
  const base = workspaceRoot(input.caps)
  const realBase = await realpath(base).catch(() => base)
  if (!inside(realBase, real)) {
    throw new ToolDeniedError('invalid-input', '文件路径越出了本会话工作区（软链）')
  }
  const realRoot = await realpath(root).catch(() => null)
  if (realRoot && !inside(realRoot, real)) {
    throw new ToolDeniedError('invalid-input', '文件路径越出了本会话工作区（软链）')
  }
  return target
}

const SEGMENT = /^[\p{L}\p{N}._-]+$/u

/**
 * 清洗 `fileKey`（会话内逻辑路径）：分段的字符白名单、禁 `..` / 绝对路径 / 空段。
 *
 * **不做静默替换**：非法字符直接拒绝，否则两个不同名字会被清洗成同一个 key。
 */
export const normalizeFileKey = (raw: string): string => {
  const value = raw?.trim() ?? ''
  if (!value) throw new ToolDeniedError('invalid-input', 'fileKey 不能为空')
  if (value.length > 255) throw new ToolDeniedError('invalid-input', 'fileKey 不能超过 255 字符')
  if (value.startsWith('/') || value.endsWith('/')) {
    throw new ToolDeniedError('invalid-input', 'fileKey 不能以 / 开头或结尾')
  }
  const segments = value.split('/')
  if (segments.length > 8) throw new ToolDeniedError('invalid-input', 'fileKey 最多 8 层')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || !SEGMENT.test(segment)) {
      throw new ToolDeniedError(
        'invalid-input',
        `fileKey 的每一段只允许字母 / 数字 / . _ -，且不能是 . 或 ..：${segment || '(空段)'}`,
      )
    }
    if (segment.startsWith('.') || segment.endsWith('.')) {
      throw new ToolDeniedError('invalid-input', 'fileKey 的每一段不能以点开头或结尾')
    }
  }
  return segments.join('/')
}

/** 展示名：取最后一段，去掉控制字符，截到 255 */
export const displayName = (value: string): string => {
  const last = value.split('/').pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim() ?? ''
  return (last || '未命名文件').slice(0, 255)
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml',
  'html', 'htm', 'log', 'sql', 'ini', 'conf', 'toml', 'properties', 'sh', 'bash',
  'py', 'ts', 'tsx', 'js', 'jsx', 'java', 'go', 'rs', 'rb', 'php', 'c', 'h',
  'cpp', 'hpp', 'css', 'scss', 'less', 'vue', 'svelte', 'graphql', 'gql',
])

export const extensionOf = (filename: string): string => {
  const base = filename.split('/').pop() ?? filename
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index + 1).toLowerCase() : ''
}

/** 按后缀判断是否文本；模型给的路径 / 文件名都走这一份判据 */
export const isTextFile = (filename: string, mediaType?: string | null): boolean => {
  const type = mediaType?.toLowerCase() ?? ''
  if (type.startsWith('text/')) return true
  if (
    type === 'application/json' ||
    type === 'application/xml' ||
    type === 'application/yaml' ||
    type === 'application/x-yaml' ||
    type === 'application/javascript' ||
    type === 'application/typescript' ||
    type === 'application/sql'
  ) {
    return true
  }
  return TEXT_EXTENSIONS.has(extensionOf(filename))
}

const MEDIA_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export const mediaTypeOf = (filename: string): string =>
  MEDIA_TYPES[extensionOf(filename)] ?? 'application/octet-stream'
