import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 「登记面 ⊇ 使用面」（issue 8）。
 *
 * workspace-service 的 `DbModule` 只登记它读的表（白名单式）。漏一张表不会在启动期报错，
 * 而是运行期抛 `EntityMetadataNotFoundError`；更糟的是初始化有 try/catch，会把错误吞成一条 warn，
 * 表面上"工作区正常"，实际凭据从初始化起就没落地过。
 *
 * 这条用例做静态扫描：源码里 `getRepository(XxxEntity)` 用到的实体，必须都在组合根白名单里。
 */

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url))

const listTsFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(full)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

describe('实体登记一致性', () => {
  it('src 里 getRepository(XxxEntity) 用到的实体都在 root.module 的 entities 白名单里', async () => {
    const files = await listTsFiles(SRC_DIR)
    const used = new Set<string>()
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(/getRepository\(\s*(\w+Entity)\s*\)/g)) {
        if (match[1]) used.add(match[1])
      }
    }

    expect(used.size).toBeGreaterThan(0)

    const rootModule = await readFile(join(SRC_DIR, 'root.module.ts'), 'utf8')
    const missing = [...used].filter((entity) => !rootModule.includes(entity))
    expect(missing).toEqual([])
  })
})
