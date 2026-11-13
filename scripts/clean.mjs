#!/usr/bin/env node
/**
 * 清理构建产物与依赖（跨平台，替代 rm -rf 链）。
 * 语义与旧脚本一致：根 node_modules + 各 workspace 的 node_modules + dist / .turbo / .next / .cache。
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const targets = new Set(['node_modules', 'dist', '.turbo', '.next', '.cache'])

for (const group of ['packages', 'apps']) {
  if (!existsSync(path.join(root, group))) continue
  for (const name of readdirSync(path.join(root, group))) {
    const dir = path.join(root, group, name)
    if (existsSync(path.join(dir, 'package.json')))
      targets.add(path.join(group, name, 'node_modules'))
  }
}

for (const target of targets) {
  rmSync(path.join(root, target), { recursive: true, force: true })
  console.log(`已删除 ${target}`)
}
