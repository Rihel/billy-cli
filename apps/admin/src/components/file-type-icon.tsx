import {
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileJsonIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  type LucideIcon,
} from 'lucide-react'

const CODE = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'sh',
  'bash',
  'zsh',
  'sql',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'xml',
  'yml',
  'yaml',
  'toml',
  'ini',
  'conf',
  'env',
  'dockerfile',
])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const SHEET = new Set(['csv', 'tsv', 'xlsx', 'xls'])
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'])
const TEXT = new Set(['md', 'markdown', 'mdx', 'txt', 'log', 'rst'])

/** 按扩展名选文件图标（树 / 列表共用；未知类型回退普通文件图标） */
export const fileIconOf = (filename: string): LucideIcon => {
  const base = filename.split('/').pop() ?? filename
  const ext = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : ''
  if (ext === 'json' || ext === 'jsonc') return FileJsonIcon
  if (CODE.has(ext) || base.toLowerCase() === 'dockerfile') return FileCodeIcon
  if (IMAGE.has(ext)) return FileImageIcon
  if (SHEET.has(ext)) return FileSpreadsheetIcon
  if (ARCHIVE.has(ext)) return FileArchiveIcon
  if (TEXT.has(ext)) return FileTextIcon
  return FileIcon
}
