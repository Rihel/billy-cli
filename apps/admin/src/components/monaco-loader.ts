'use client'

import { Editor, loader } from '@monaco-editor/react'

/**
 * Monaco 本地化入口（只在客户端加载）。
 *
 * `loader.config` 把 AMD loader 指向本站的 `/monaco/vs`——资源由 `scripts/copy-monaco.mjs`
 * 在 build 前从 `node_modules/monaco-editor/min/vs` 拷来，不依赖 jsdelivr。
 */
loader.config({ paths: { vs: '/monaco/vs' } })

// AMD 版默认找 `vs/base/worker/workerMain.js`，0.57 的 min/vs 只在 `editor/editor.worker.js` 带 worker
if (typeof window !== 'undefined') {
  ;(
    window as unknown as { MonacoEnvironment?: { getWorkerUrl?: () => string } }
  ).MonacoEnvironment = { getWorkerUrl: () => '/monaco/vs/editor/editor.worker.js' }
}

export { Editor }
