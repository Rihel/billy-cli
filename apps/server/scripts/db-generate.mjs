#!/usr/bin/env node
/**
 * 生成 TypeORM 迁移（跨平台，替代 bash -c 包一层）。
 *
 * 用法：pnpm db:gen <Name>
 * 实际执行：node --import tsx node_modules/typeorm/cli.js migration:generate src/database/migrations/<Name> -d ./data-source.ts
 */
import { spawnSync } from 'node:child_process'

const name = process.argv[2]
if (!name) {
  console.error('用法：pnpm db:gen <Name>（Name 会拼到 src/database/migrations/ 下）')
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    'node_modules/typeorm/cli.js',
    'migration:generate',
    `src/database/migrations/${name}`,
    '-d',
    './data-source.ts',
  ],
  { stdio: 'inherit' },
)

process.exit(result.status ?? 1)
