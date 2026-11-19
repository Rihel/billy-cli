import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 把 `monaco-editor/min/vs` 拷到 `public/monaco/vs`，让 Monaco 的 AMD loader 从本站加载。
 *
 * 好处：不依赖 jsdelivr CDN；代价：约 20MB 静态资源（不进 git，build 前生成）。
 */
const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', 'node_modules', 'monaco-editor', 'min', 'vs')
const target = join(here, '..', 'public', 'monaco', 'vs')

rmSync(target, { recursive: true, force: true })
mkdirSync(join(here, '..', 'public', 'monaco'), { recursive: true })
cpSync(source, target, { recursive: true })
console.log('[monaco] 已拷贝 min/vs → public/monaco/vs')
