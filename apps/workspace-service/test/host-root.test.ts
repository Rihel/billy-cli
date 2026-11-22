import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveLocalRoot } from '../src/workspace/host-root.js'

/**
 * local 后端的根目录解析：平台托管目录 vs 文件夹。
 *
 * 钉的是**闸口**本身：文件夹要过「绝对路径 / 不是 `/` / 存在且是目录 / 在允许根之内 /
 * 不覆盖凭据目录」五道闸；平台托管分支保持老行为（`<localRoot>/<workspaceId>`、要初始化）。
 * 沙箱模式那道闸在 runtime 里（需要 config），见 workspace-runtime.test.ts。
 */

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const makeTemp = async (prefix = 'ws-host-'): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

describe('resolveLocalRoot：平台托管目录', () => {
  it('没填文件夹 → <localRoot>/<workspaceId>，且要初始化', async () => {
    const localRoot = await makeTemp()
    const plan = await resolveLocalRoot({ localRoot, workspaceId: 'ws_1', allowedRoots: [] })
    expect(plan.managed).toBe(true)
    expect(plan.root).toBe(join(localRoot, 'ws_1'))
  })
})

describe('resolveLocalRoot：文件夹的五道闸', () => {
  it('相对路径拒绝', async () => {
    const localRoot = await makeTemp()
    await expect(
      resolveLocalRoot({
        localRoot,
        workspaceId: 'ws_1',
        requested: 'code/project',
        allowedRoots: ['/'],
      }),
    ).rejects.toThrow(/完整路径/)
  })

  it('根目录 / 拒绝', async () => {
    const localRoot = await makeTemp()
    await expect(
      resolveLocalRoot({ localRoot, workspaceId: 'ws_1', requested: '/', allowedRoots: ['/'] }),
    ).rejects.toThrow(/整个磁盘根目录/)
  })

  it('没配允许根 → 关闭该能力（不默认放行）', async () => {
    const host = await makeTemp()
    await expect(
      resolveLocalRoot({
        localRoot: await makeTemp(),
        workspaceId: 'ws_1',
        requested: host,
        allowedRoots: [],
      }),
    ).rejects.toThrow(/WORKSPACE_LOCAL_ALLOWED_ROOTS/)
  })

  it('目录不存在 → 拒绝', async () => {
    const allowed = await makeTemp()
    await expect(
      resolveLocalRoot({
        localRoot: await makeTemp(),
        workspaceId: 'ws_1',
        requested: join(allowed, 'not-exist'),
        allowedRoots: [allowed],
      }),
    ).rejects.toThrow(/不存在/)
  })

  it('是文件不是目录 → 拒绝', async () => {
    const allowed = await makeTemp()
    const file = join(allowed, 'README.md')
    await writeFile(file, 'x')
    await expect(
      resolveLocalRoot({
        localRoot: await makeTemp(),
        workspaceId: 'ws_1',
        requested: file,
        allowedRoots: [allowed],
      }),
    ).rejects.toThrow(/不是文件夹/)
  })

  it('不在允许根之内 → 拒绝', async () => {
    const host = await makeTemp()
    const allowed = await makeTemp()
    await expect(
      resolveLocalRoot({
        localRoot: await makeTemp(),
        workspaceId: 'ws_1',
        requested: host,
        allowedRoots: [allowed],
      }),
    ).rejects.toThrow(/允许的范围/)
  })

  it('目录过宽、覆盖凭据目录 → 拒绝', async () => {
    const home = await makeTemp('ws-home-')
    await mkdir(join(home, '.ssh'), { recursive: true })
    const project = join(home, 'code')
    await mkdir(project, { recursive: true })
    await expect(
      resolveLocalRoot({
        localRoot: await makeTemp(),
        workspaceId: 'ws_1',
        requested: home,
        allowedRoots: [home],
        denyPaths: [join(home, '.ssh')],
      }),
    ).rejects.toThrow(/包含凭据目录/)
  })

  it('合法文件夹 → realpath 归一、且不初始化', async () => {
    const allowed = await makeTemp()
    const project = join(allowed, 'my-project')
    await mkdir(project, { recursive: true })
    const plan = await resolveLocalRoot({
      localRoot: await makeTemp(),
      workspaceId: 'ws_1',
      requested: project,
      allowedRoots: [allowed],
      denyPaths: [],
    })
    expect(plan.managed).toBe(false)
    // macOS 的 /var 是 /private/var 的软链：比较 realpath 后的路径
    expect(plan.root).toBe(await realpath(project))
  })

  it('软链按 realpath 后的真实路径判断（不能靠软链绕过允许根）', async () => {
    const allowed = await makeTemp()
    const outside = await makeTemp()
    const link = join(allowed, 'link-to-outside')
    await symlink(outside, link)
    await expect(
      resolveLocalRoot({
        localRoot: await makeTemp(),
        workspaceId: 'ws_1',
        requested: link,
        allowedRoots: [allowed],
      }),
    ).rejects.toThrow(/允许的范围/)
  })
})
