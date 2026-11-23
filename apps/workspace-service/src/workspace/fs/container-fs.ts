import { join, relative, resolve } from 'node:path'
import type { WorkspaceFsRequest, WorkspaceFsResult } from '@repo/contracts'
import type { CommandOutcome } from '../container/driver.js'
import { buildFindTreeCommand, parseFindTree } from './find-tree.js'
import { tmpSuffix } from './tmp.js'

/** 容器内固定工作目录（与镜像约定一致） */
const CONTAINER_WORKDIR = '/workspace'

/** 容器命令执行器：由驱动注入（docker exec / kubectl exec） */
export type ContainerFsExec = (command: string, stdin?: string) => Promise<CommandOutcome>

/**
 * **容器文件能力**：把统一的 fs op 翻译成容器内命令（`ls` / `find` / `cat` / `mv` …）。
 *
 * 与 `host-fs.ts` 是同一套 op 的两种实现：语义必须一致（原子写、越界、搜索），
 * 差异只在「怎么执行」。
 */
export type ContainerFs = (
  exec: ContainerFsExec,
  request: WorkspaceFsRequest,
) => Promise<WorkspaceFsResult>

/**
 * 命令失败 → fs 结果：**先看退出码，再归因**。
 *
 * 旧实现 stat / read-bytes 不看退出码：文件不存在时 `stat` 的 stdout 为空，
 * 照样回 `ok:true, type:'file'`，上层把「真没有」当「读到了空文件」（issue 4 的 404 根因之一）。
 * `no such file` / `cannot stat` 归 `not-found`，其余归 `exec-failed`。
 */
const failureOf = (out: CommandOutcome): WorkspaceFsResult => ({
  ok: false,
  reason: /no such file|cannot stat|not found/i.test(out.stderr) ? 'not-found' : 'exec-failed',
  message: out.stderr || `退出码 ${out.code}`,
})

export const containerFs: ContainerFs = async (exec, request) => {
  const target = resolve(CONTAINER_WORKDIR, request.path)
  if (!target.startsWith(CONTAINER_WORKDIR)) {
    return { ok: false, reason: 'unsafe-path', message: '路径必须工作区内' }
  }
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`
  try {
    switch (request.op) {
      case 'list': {
        const out = await exec(`ls -1p ${quote(target)}`)
        const entries = out.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => (line && !line.endsWith('/') ? true : line.length > 1))
          .filter((line) => line !== './')
          .map((line) => {
            const dir = line.endsWith('/')
            const name = dir ? line.slice(0, -1) : line
            // 与 host 对齐：path 是相对**工作区根**的路径，不是相对当前目录
            return {
              name,
              path: relative(CONTAINER_WORKDIR, join(target, name)),
              type: dir ? 'dir' : 'file',
            }
          })
        return { ok: true, data: { entries } }
      }
      case 'list-tree': {
        // 容器后端：**一次 find** 拿回全部路径 / 大小 / mtime（根治逐文件 docker exec）
        const out = await exec(
          buildFindTreeCommand(target, request.maxDepth ?? 16, request.excludeDirs ?? []),
        )
        if (out.code !== 0) return { ok: false, reason: 'exec-failed', message: out.stderr }
        return { ok: true, data: { entries: parseFindTree(out.stdout) } }
      }
      case 'read': {
        const out = await exec(`cat ${quote(target)}`)
        // 文件不存在时 `cat` 非 0：不能把空输出当成"读到了空清单"（会把拒绝永久化）
        if (out.code !== 0) return { ok: false, reason: 'exec-failed', message: out.stderr }
        return {
          ok: true,
          data: { path: request.path, content: out.stdout, bytes: Buffer.byteLength(out.stdout) },
        }
      }
      case 'read-bytes': {
        const out = await exec(`base64 -w0 ${quote(target)}`)
        if (out.code !== 0) return failureOf(out)
        return { ok: true, data: { base64: out.stdout.trim() } }
      }
      case 'write-bytes': {
        const tmp = `${target}${tmpSuffix()}`
        const out = await exec(
          `mkdir -p "$(dirname ${quote(target)})" && base64 -d > ${quote(tmp)} && mv -f ${quote(tmp)} ${quote(target)}`,
          request.base64 ?? '',
        )
        if (out.code !== 0) {
          await exec(`rm -f ${quote(tmp)}`).catch(() => undefined)
          return { ok: false, reason: 'exec-failed', message: out.stderr }
        }
        return { ok: true, data: { path: request.path } }
      }
      case 'write':
      case 'append':
      case 'replace': {
        const content = request.content ?? ''
        // 追加不重建文件；写 / 替换走「同目录 tmp + mv」，容器内 mv 是原子 rename
        if (request.op === 'append') {
          const out = await exec(
            `mkdir -p "$(dirname ${quote(target)})" && cat >> ${quote(target)}`,
            content,
          )
          if (out.code !== 0) {
            return { ok: false, reason: 'exec-failed', message: out.stderr }
          }
          return { ok: true, data: { path: request.path, bytes: Buffer.byteLength(content) } }
        }
        const tmp = `${target}${tmpSuffix()}`
        const out = await exec(
          `mkdir -p "$(dirname ${quote(target)})" && cat > ${quote(tmp)} && mv -f ${quote(tmp)} ${quote(target)}`,
          content,
        )
        if (out.code !== 0) {
          await exec(`rm -f ${quote(tmp)}`).catch(() => undefined)
          return { ok: false, reason: 'exec-failed', message: out.stderr }
        }
        return { ok: true, data: { path: request.path, bytes: Buffer.byteLength(content) } }
      }
      case 'stat': {
        const out = await exec(`stat -c '%F|%s|%Y' ${quote(target)}`)
        if (out.code !== 0) return failureOf(out)
        const [kind, size, mtime] = out.stdout.trim().split('|')
        return {
          ok: true,
          data: {
            path: request.path,
            type: kind?.includes('directory') ? 'dir' : 'file',
            size: Number(size ?? 0),
            mtime: Number(mtime ?? 0) * 1000,
          },
        }
      }
      case 'remove': {
        await exec(`rm -rf ${quote(target)}`)
        return { ok: true, data: { path: request.path, removed: true } }
      }
      case 'search': {
        const out = await exec(`grep -r -l ${quote(request.query ?? '')} ${quote(target)}`)
        return {
          ok: true,
          data: {
            matches: out.stdout
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              // 与 host 对齐：结果相对工作区根（grep 返回容器内绝对路径）
              .map((line) => relative(CONTAINER_WORKDIR, line)),
          },
        }
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'exec-failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
