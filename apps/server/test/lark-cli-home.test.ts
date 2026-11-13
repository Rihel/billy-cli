import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import {
  restoreHome,
  sameFiles,
  snapshotHome,
} from '../src/modules/ai/connectors/drivers/lark-cli.home.js'

/**
 * lark-cli HOME 的搬运（纯文件层，不跑 CLI）。
 *
 * 这条链是「无状态 pod 还能保留飞书授权」的关键：从库恢复到临时 HOME、调用后写回。
 */

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'lark-home-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('lark-cli HOME 快照', () => {
  it('快照 → 恢复：文件内容与相对路径不变', async () => {
    await withTempDir(async (source) => {
      await mkdir(join(source, '.lark-cli'), { recursive: true })
      await mkdir(join(source, '.local', 'share', 'lark-cli'), { recursive: true })
      await writeFile(join(source, '.lark-cli', 'config.json'), '{"apps":[]}')
      await writeFile(join(source, '.local', 'share', 'lark-cli', 'master.key'), 'secret')
      await writeFile(join(source, 'state.json'), '{"fp":"x"}')

      const files = await snapshotHome(source)
      expect(Object.keys(files).sort()).toEqual(
        ['.lark-cli/config.json', '.local/share/lark-cli/master.key', 'state.json'].sort(),
      )

      await withTempDir(async (target) => {
        await restoreHome(target, files)
        expect(await readFile(join(target, '.lark-cli', 'config.json'), 'utf8')).toBe('{"apps":[]}')
        expect(
          await readFile(join(target, '.local', 'share', 'lark-cli', 'master.key'), 'utf8'),
        ).toBe('secret')
      })
    })
  })

  it('缓存目录不进快照，两次快照可以比较相等', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'cache'), { recursive: true })
      await writeFile(join(dir, 'cache', 'big.bin'), 'x'.repeat(1024))
      await writeFile(join(dir, 'keep.txt'), 'keep')

      const files = await snapshotHome(dir)
      expect(Object.keys(files)).toEqual(['keep.txt'])
      expect(sameFiles(files, { 'keep.txt': Buffer.from('keep').toString('base64') })).toBe(true)
      expect(sameFiles(files, null)).toBe(false)
    })
  })

  it('恢复时忽略越界路径（不写 HOME 之外）', async () => {
    await withTempDir(async (dir) => {
      await restoreHome(dir, {
        '../evil.txt': Buffer.from('bad').toString('base64'),
        'ok.txt': Buffer.from('ok').toString('base64'),
      })
      await expect(readFile(join(dir, 'ok.txt'), 'utf8')).resolves.toBe('ok')
      await expect(readFile(join(dir, '..', 'evil.txt'), 'utf8')).rejects.toThrow(/ENOENT/)
    })
  })
})
