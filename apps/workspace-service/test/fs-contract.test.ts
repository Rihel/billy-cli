import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceFsRequest, WorkspaceFsResult } from '@repo/contracts'
import { containerFs, type ContainerFsExec } from '../src/workspace/fs/container-fs.js'
import { hostFs } from '../src/workspace/fs/host-fs.js'

/**
 * **fs 一致性测试**（`docs/design/workspace-env-contract.md` §6）。
 *
 * 同一组 op 用例跑两种实现：
 * - `hostFs`：真实 Node fs；
 * - `containerFs`：注入一个「把容器命令翻译成真实 fs 操作」的假执行器，
 *   于是两侧的结果可以逐条比对 —— 语义漂移（路径基准、缺失字段、越界判断）当场红。
 */

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const CONTAINER_ROOT = '/workspace'

/** 容器内路径 → 临时目录里的真实路径 */
const toReal = (root: string, path: string): string => resolve(root, relative(CONTAINER_ROOT, path))

const ok = (stdout = '') => ({
  code: 0,
  stdout,
  stderr: '',
  durationMs: 0,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
})
const fail = (stderr = 'boom') => ({
  code: 1,
  stdout: '',
  stderr,
  durationMs: 0,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
})

/** 假执行器：只认 containerFs 真正会发的那几种命令 */
const fakeExec =
  (root: string): ContainerFsExec =>
  async (command, stdin) => {
    const unquote = (raw: string): string => raw.replace(/^'|'$/g, '')
    let m = /^ls -1p '([^']+)'$/.exec(command)
    if (m) {
      const dir = toReal(root, unquote(m[1]!))
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      return ok(entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') + '\n')
    }
    m = /^cat '([^']+)'$/.exec(command)
    if (m) {
      const content = await readFile(toReal(root, unquote(m[1]!)), 'utf8').catch(() => null)
      return content === null ? fail('cat: no such file') : ok(content)
    }
    m = /^base64 -w0 '([^']+)'$/.exec(command)
    if (m) {
      const body = await readFile(toReal(root, unquote(m[1]!))).catch(() => null)
      return body === null ? fail('no such file') : ok(body.toString('base64'))
    }
    m = /^stat -c '%F\|%s\|%Y' '([^']+)'$/.exec(command)
    if (m) {
      const info = await stat(toReal(root, unquote(m[1]!))).catch(() => null)
      if (!info) return fail('stat: no such file')
      return ok(
        `${info.isDirectory() ? 'directory' : 'regular file'}|${info.size}|${Math.floor(info.mtimeMs / 1000)}`,
      )
    }
    m = /^rm -rf '([^']+)'$/.exec(command)
    if (m) {
      await rm(toReal(root, unquote(m[1]!)), { recursive: true, force: true })
      return ok()
    }
    m = /^mkdir -p "\$\(dirname '([^']+)'\)" && cat > '([^']+)' && mv -f '([^']+)' '([^']+)'$/.exec(
      command,
    )
    if (m) {
      const [, , tmp, , target] = m
      const tmpReal = toReal(root, unquote(tmp!))
      const targetReal = toReal(root, unquote(target!))
      await mkdir(resolve(targetReal, '..'), { recursive: true })
      await writeFile(tmpReal, stdin ?? '', 'utf8')
      await rename(tmpReal, targetReal)
      return ok()
    }
    m =
      /^mkdir -p "\$\(dirname '([^']+)'\)" && base64 -d > '([^']+)' && mv -f '([^']+)' '([^']+)'$/.exec(
        command,
      )
    if (m) {
      const [, , tmp, , target] = m
      const tmpReal = toReal(root, unquote(tmp!))
      const targetReal = toReal(root, unquote(target!))
      await mkdir(resolve(targetReal, '..'), { recursive: true })
      await writeFile(tmpReal, Buffer.from(stdin ?? '', 'base64'))
      await rename(tmpReal, targetReal)
      return ok()
    }
    m = /^mkdir -p "\$\(dirname '([^']+)'\)" && cat >> '([^']+)'$/.exec(command)
    if (m) {
      await mkdir(resolve(toReal(root, unquote(m[2]!)), '..'), { recursive: true })
      const existing = await readFile(toReal(root, unquote(m[2]!)), 'utf8').catch(() => '')
      await writeFile(toReal(root, unquote(m[2]!)), existing + (stdin ?? ''), 'utf8')
      return ok()
    }
    m = /^find '([^']+)' -maxdepth (\d+) -type f (.*)-printf '%P\\t%s\\t%T@\\n'$/.exec(command)
    if (m) {
      const dir = toReal(root, unquote(m[1]!))
      const lines: string[] = []
      const walk = async (current: string, depth: number): Promise<void> => {
        if (depth > Number(m![2])) return
        for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
          const full = join(current, entry.name)
          if (entry.isDirectory()) {
            if (m![3]?.includes(`*/${entry.name}/*`)) continue
            await walk(full, depth + 1)
            continue
          }
          const info = await stat(full).catch(() => null)
          if (info)
            lines.push(`${relative(dir, full)}\t${info.size}\t${Math.floor(info.mtimeMs / 1000)}`)
        }
      }
      await walk(dir, 0)
      return ok(lines.join('\n') + '\n')
    }
    m = /^grep -r -l '([^']*)' '([^']+)'$/.exec(command)
    if (m) {
      const dir = toReal(root, unquote(m[2]!))
      const matches: string[] = []
      const walk = async (current: string): Promise<void> => {
        for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
          const full = join(current, entry.name)
          if (entry.isDirectory()) {
            await walk(full)
            continue
          }
          const content = await readFile(full, 'utf8').catch(() => '')
          if (content.includes(unquote(m![1]!)))
            matches.push(`${CONTAINER_ROOT}/${relative(root, full)}`)
        }
      }
      await walk(dir)
      return ok(matches.join('\n') + (matches.length ? '\n' : ''))
    }
    return fail(`未模拟的命令：${command}`)
  }

/** 两种实现的统一入口：`impl` 返回一侧的 fs 调用 */
type Impl = (request: WorkspaceFsRequest) => Promise<WorkspaceFsResult>

const makeImpls = async (): Promise<
  { name: string; impl: Impl; root: string; fsRoot: string }[]
> => {
  const hostRoot = await mkdtemp(join(tmpdir(), 'fs-contract-host-'))
  const containerRoot = await mkdtemp(join(tmpdir(), 'fs-contract-container-'))
  cleanup.push(hostRoot, containerRoot)
  return [
    {
      name: 'hostFs',
      impl: (request) => hostFs(hostRoot, request),
      root: hostRoot,
      fsRoot: hostRoot,
    },
    {
      name: 'containerFs',
      impl: (request) => containerFs(fakeExec(containerRoot), request),
      root: CONTAINER_ROOT,
      // 断言真实文件系统时用这个根
      fsRoot: containerRoot,
    },
  ]
}

describe('fs 一致性：同一组用例跑两种实现', () => {
  it('写后读回（含中文与 emoji），读不存在的文件返回失败', async () => {
    const impls = await makeImpls()
    const content = '你好 👋\nsecond line'
    for (const item of impls) {
      const written = await item.impl({
        workspaceId: 'ws',
        op: 'write',
        path: 'a/note.txt',
        content,
      })
      expect(written.ok).toBe(true)
      const read = await item.impl({ workspaceId: 'ws', op: 'read', path: 'a/note.txt' })
      expect(read.ok).toBe(true)
      expect((read.data as { content: string }).content).toBe(content)
      expect((read.data as { bytes: number }).bytes).toBe(Buffer.byteLength(content))

      const missing = await item.impl({ workspaceId: 'ws', op: 'read', path: 'a/none.txt' })
      expect(missing.ok).toBe(false)
    }
  })

  it('越界路径被拒（../ 与绝对路径）', async () => {
    const impls = await makeImpls()
    for (const item of impls) {
      for (const path of ['../outside.txt', '/etc/passwd']) {
        const result = await item.impl({ workspaceId: 'ws', op: 'read', path })
        expect(result.ok).toBe(false)
        expect(result.reason).toBe('unsafe-path')
      }
    }
  })

  it('列目录：路径相对工作区根、类型正确', async () => {
    const impls = await makeImpls()
    for (const item of impls) {
      await item.impl({ workspaceId: 'ws', op: 'write', path: 'dir/file.txt', content: 'x' })
      const listed = await item.impl({ workspaceId: 'ws', op: 'list', path: 'dir' })
      expect(listed.ok).toBe(true)
      const entries = (listed.data as { entries: { name: string; path: string; type: string }[] })
        .entries
      expect(entries).toEqual([{ name: 'file.txt', path: 'dir/file.txt', type: 'file' }])
    }
  })

  it('列树：相对请求目录、支持排除目录', async () => {
    const impls = await makeImpls()
    for (const item of impls) {
      await item.impl({ workspaceId: 'ws', op: 'write', path: 'tree/a.txt', content: 'a' })
      await item.impl({
        workspaceId: 'ws',
        op: 'write',
        path: 'tree/node_modules/b.txt',
        content: 'b',
      })
      const result = await item.impl({
        workspaceId: 'ws',
        op: 'list-tree',
        path: 'tree',
        excludeDirs: ['node_modules'],
      })
      expect(result.ok).toBe(true)
      const paths = (result.data as { entries: { path: string }[] }).entries.map((e) => e.path)
      expect(paths).toEqual(['a.txt'])
    }
  })

  it('搜索：命中相对工作区根、无命中返回空数组', async () => {
    const impls = await makeImpls()
    for (const item of impls) {
      await item.impl({ workspaceId: 'ws', op: 'write', path: 's/one.txt', content: 'needle here' })
      await item.impl({ workspaceId: 'ws', op: 'write', path: 's/two.txt', content: 'nothing' })
      const hit = await item.impl({ workspaceId: 'ws', op: 'search', path: 's', query: 'needle' })
      expect(hit.ok).toBe(true)
      expect((hit.data as { matches: string[] }).matches).toEqual(['s/one.txt'])
      const miss = await item.impl({ workspaceId: 'ws', op: 'search', path: 's', query: 'absent' })
      expect((miss.data as { matches: string[] }).matches).toEqual([])
    }
  })

  it('追加与删除', async () => {
    const impls = await makeImpls()
    for (const item of impls) {
      await item.impl({ workspaceId: 'ws', op: 'write', path: 'd/log.txt', content: 'a\n' })
      await item.impl({ workspaceId: 'ws', op: 'append', path: 'd/log.txt', content: 'b\n' })
      const read = await item.impl({ workspaceId: 'ws', op: 'read', path: 'd/log.txt' })
      expect((read.data as { content: string }).content).toBe('a\nb\n')

      const removed = await item.impl({ workspaceId: 'ws', op: 'remove', path: 'd' })
      expect(removed.ok).toBe(true)
      const after = await item.impl({ workspaceId: 'ws', op: 'read', path: 'd/log.txt' })
      expect(after.ok).toBe(false)
    }
  })

  it('二进制读写走 base64', async () => {
    const impls = await makeImpls()
    const body = Buffer.from([0, 1, 2, 253, 254, 255])
    for (const item of impls) {
      await item.impl({
        workspaceId: 'ws',
        op: 'write-bytes',
        path: 'bin/x.bin',
        base64: body.toString('base64'),
      })
      const read = await item.impl({ workspaceId: 'ws', op: 'read-bytes', path: 'bin/x.bin' })
      expect(Buffer.from((read.data as { base64: string }).base64, 'base64').equals(body)).toBe(
        true,
      )
    }
  })

  it('原子写不残留临时文件', async () => {
    const impls = await makeImpls()
    for (const item of impls) {
      await item.impl({ workspaceId: 'ws', op: 'write', path: 'atomic/a.txt', content: 'done' })
      const listed = await readdir(join(item.fsRoot, 'atomic'))
      expect(listed).toEqual(['a.txt'])
    }
  })

  it('stat 返回类型、大小与毫秒时间', async () => {
    const impls = await makeImpls()
    for (const item of impls) {
      await item.impl({ workspaceId: 'ws', op: 'write', path: 'st/a.txt', content: 'abcd' })
      const info = await item.impl({ workspaceId: 'ws', op: 'stat', path: 'st/a.txt' })
      expect(info.ok).toBe(true)
      const data = info.data as { type: string; size: number; mtime: number }
      expect(data.type).toBe('file')
      expect(data.size).toBe(4)
      expect(data.mtime).toBeGreaterThan(0)
    }
  })
})
