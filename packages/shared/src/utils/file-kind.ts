import type { OfficeKind, PreviewKind } from '../schema/share.schema'

/**
 * 文件类型判定：**全工程唯一的一份**，服务端据此下发 `previewKind`，前端只 switch。
 *
 * 为什么不让前端自己猜：同一份判据写在两处必然漂移；而「猜错」的后果是不对称的 ——
 * 把 HTML 当文本塞进 iframe 就是存储型 XSS，把图片当未知只是多一个下载按钮。
 * 所以这里的规则是：**拿不准一律 `none`**。
 */

/** 文本类扩展名（含代码 / 配置；`html` 也在这里，但会被更早的 html 分支拦下） */
export const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'log',
  'sql',
  'ini',
  'conf',
  'toml',
  'properties',
  'sh',
  'bash',
  'py',
  'ts',
  'tsx',
  'js',
  'jsx',
  'java',
  'go',
  'rs',
  'rb',
  'php',
  'c',
  'h',
  'cpp',
  'hpp',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
  'graphql',
  'gql',
])

export const extensionOf = (filename: string): string => {
  const base = filename.split('/').pop() ?? filename
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index + 1).toLowerCase() : ''
}

export const isTextExtension = (filename: string): boolean =>
  TEXT_EXTENSIONS.has(extensionOf(filename))

const OFFICE_EXTENSIONS: Record<string, OfficeKind> = {
  docx: 'docx',
  xlsx: 'xlsx',
  xls: 'xlsx',
  pptx: 'pptx',
}

const OFFICE_MEDIA_TYPES: Record<string, OfficeKind> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}

const TEXT_MEDIA_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/typescript',
  'application/sql',
])

const isTextMediaType = (mediaType: string): boolean =>
  mediaType.startsWith('text/') || TEXT_MEDIA_TYPES.has(mediaType)

/**
 * 解析预览方式。
 *
 * 判定顺序（先命中先返回）：office → html → markdown → pdf → 图片（不含 svg）→ 音视频 → 文本 → none。
 * `mediaType` 与扩展名**任一**指向危险类型就按危险处理（例如 `.html` 但登记成 `text/plain`，
 * 仍然按 `html` 走沙箱渲染）。
 */
export const resolvePreviewKind = (input: {
  filename: string
  mediaType: string
}): { kind: PreviewKind; officeKind: OfficeKind | null } => {
  const mediaType = (input.mediaType ?? '').toLowerCase()
  const extension = extensionOf(input.filename)

  const officeKind = OFFICE_MEDIA_TYPES[mediaType] ?? OFFICE_EXTENSIONS[extension] ?? null
  if (officeKind) return { kind: 'office', officeKind }

  if (mediaType === 'text/html' || extension === 'html' || extension === 'htm') {
    return { kind: 'html', officeKind: null }
  }
  if (mediaType === 'text/markdown' || extension === 'md' || extension === 'markdown') {
    return { kind: 'markdown', officeKind: null }
  }
  if (mediaType === 'application/pdf' || extension === 'pdf') {
    return { kind: 'pdf', officeKind: null }
  }
  if (
    mediaType.startsWith('image/') ||
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(extension)
  ) {
    // svg 能带脚本，一律不内联
    if (mediaType === 'image/svg+xml' || extension === 'svg') {
      return { kind: 'none', officeKind: null }
    }
    return { kind: 'image', officeKind: null }
  }
  if (mediaType.startsWith('video/')) return { kind: 'video', officeKind: null }
  if (mediaType.startsWith('audio/')) return { kind: 'audio', officeKind: null }
  if (isTextMediaType(mediaType) || isTextExtension(input.filename)) {
    return { kind: 'text', officeKind: null }
  }
  return { kind: 'none', officeKind: null }
}
