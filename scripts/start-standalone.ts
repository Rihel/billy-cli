#!/usr/bin/env node
/**
 * 启动 Next standalone 产物（跨平台，替代原先的 start.sh）。
 *
 * 用法（在各 app 目录下）：node ../../scripts/start-standalone.ts <app> <默认端口>
 * - standalone 产物按 outputFileTracingRoot（仓库根）落盘：.next/standalone/apps/<app>
 * - 把 .next/static 与 public 拷进 standalone，再起 server.js
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync } from 'node:fs'
import path from 'node:path'

const [app, defaultPort] = process.argv.slice(2) as [string | undefined, string | undefined]
if (!app) {
  console.error('用法：node scripts/start-standalone.ts <app> <默认端口>')
  process.exit(1)
}

const standalone = path.join('.next', 'standalone', 'apps', app)
if (!existsSync(standalone)) {
  console.error(`未找到 standalone 产物：${standalone}；请先执行 pnpm build`)
  process.exit(1)
}

const copies: Array<[string, string]> = [
  [path.join('.next', 'static'), path.join(standalone, '.next', 'static')],
  ['public', path.join(standalone, 'public')],
]
for (const [from, to] of copies) {
  if (existsSync(from)) cpSync(from, to, { recursive: true })
}

const port = process.env.PORT ?? defaultPort
const child = spawn(process.execPath, [path.join(standalone, 'server.js')], {
  stdio: 'inherit',
  env: { ...process.env, PORT: port },
})

child.on('error', (error) => {
  console.error(`启动失败：${error.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
