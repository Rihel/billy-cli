import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommandRunner } from '../src/foundation/command/command.runner.js'
import { describePlatform, resolveShell } from '../src/foundation/command/command.platform.js'

/**
 * 跨平台命令执行统一入口：**三端行为一致**是它的全部价值，所以这里钉住的都是"边界"：
 * 超时、截断、非零退出、目录不存在、中止信号、孙进程不拖死调用 —— 以及"永不抛异常"这条硬约定。
 *
 * 机制在 `execa` 里（跨平台 shell、杀进程树、输出上限都是它的能力），本测试断言的是
 * **我们这层封装的口径**：失败也返回结构化中文结果、`timedOut` / `aborted` / `truncated` 分得清。
 *
 * 环境信息（`describePlatform`）用**注入的入参**覆盖 Windows / Linux / macOS 三种取值：
 * CI 只跑一种系统，不把三端逻辑测出来等于没测。
 */
const runner = new CommandRunner()

describe('CommandRunner（跨平台命令执行）', () => {
  it('正常命令：退出码 0，stdout 带回结果（`echo` 在 cmd 与 sh 下都存在，是刻意的可移植取例）', async () => {
    const result = await runner.run({ command: 'echo billy-command-ok' })
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('billy-command-ok')
    expect(result.timedOut).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.reason).toBeUndefined()
    // shell 与工作目录原样回显（出参要能解释"这条命令是谁解释的、在哪跑的"）
    expect(result.shell).toBe(resolveShell(process.platform))
    expect(result.cwd).toBe(process.cwd())
  })

  it('非零退出：不抛异常，退出码与原因一并返回（模型据此自己纠正）', async () => {
    const result = await runner.run({ command: 'node -e "process.exit(3)"' })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.reason).toContain('3')
  })

  it('超时：杀掉命令并如实标记 timedOut（默认 15s 太长，这里显式给 300ms）', async () => {
    const startedAt = Date.now()
    const result = await runner.run({
      command: 'node -e "setTimeout(function () {}, 30000)"',
      timeoutMs: 300,
    })
    expect(result.timedOut).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })

  it('超时要连孙进程一起杀：孙进程占着输出管道时也不能把工具调用挂死', async () => {
    // 命令自己起一个继承 stdout 的后台进程（模拟 `npm run dev` 这类会留下子进程的命令）：
    // 只杀 shell 的话，孙进程会一直占着管道 —— execa 的 `killDescendants` 在 Unix 用进程组、
    // 在 Windows 用 taskkill，正是为这一条（手写版在 Windows 上解决不了）
    const script = join(tmpdir(), `billy-command-orphan-${process.pid}.cjs`)
    writeFileSync(
      script,
      "const { spawn } = require('node:child_process')\n" +
        "spawn(process.execPath, ['-e', 'setTimeout(function () {}, 30000)'], { stdio: 'inherit' })\n",
    )
    try {
      const startedAt = Date.now()
      const result = await runner.run({ command: `node "${script}"`, timeoutMs: 400 })
      expect(result.timedOut).toBe(true)
      expect(result.ok).toBe(false)
      // 关键断言：没被孙进程拖住（vitest 单测上限 5s，这里再收紧到 4s）
      expect(Date.now() - startedAt).toBeLessThan(4000)
    } finally {
      rmSync(script, { force: true })
    }
  })

  it('输出超限：截断并终止（`ls -R /` 这类命令不能把服务打满）', async () => {
    const result = await runner.run({
      command: 'node -e "console.log(String.fromCharCode(120).repeat(5000))"',
      maxOutputBytes: 128,
    })
    expect(result.truncated).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('截断')
  })

  it('cwd：在指定目录下执行（用系统临时目录，三端都存在）', async () => {
    const result = await runner.run({
      command: 'node -e "console.log(process.cwd())"',
      cwd: tmpdir(),
    })
    expect(result.ok).toBe(true)
    // macOS 的 /var 是指向 /private/var 的软链，Node 报的是真实路径 → 比较真实路径
    expect(result.stdout).toContain(join(tmpdir()))
  })

  it('目录不存在：进程没跑起来也不抛异常，exitCode 为 null 且给出原因', async () => {
    const result = await runner.run({
      command: 'echo nope',
      cwd: join(tmpdir(), 'billy-not-exists-dir-xyz'),
    })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(result.reason).toContain('未能执行')
  })

  it('中止信号：用户点停止要连命令一起停（aborted 标记，不当成超时）', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const result = await runner.run({
      command: 'node -e "setTimeout(function () {}, 30000)"',
      timeoutMs: 30_000,
      signal: controller.signal,
    })
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.reason).toContain('中止')
  })
})

describe('平台识别（不依赖平台专属命令：`uname` / `ver` 只在部分系统存在）', () => {
  it('macOS / Linux / Windows 三端各自的 shell 与展示名', () => {
    const mac = describePlatform('darwin', '24.6.0', 'arm64')
    expect(mac.label).toBe('macOS 24.6.0（darwin / arm64）')
    expect(mac.shell).toBe('/bin/sh')

    const linux = describePlatform('linux', '6.8.0', 'x64')
    expect(linux.label).toBe('Linux 6.8.0（linux / x64）')
    expect(linux.shell).toBe('/bin/sh')

    const windows = describePlatform('win32', '10.0.22631', 'x64')
    expect(windows.label).toBe('Windows 10.0.22631（win32 / x64）')
    // Windows 上 Node 用 %ComSpec%（通常 cmd.exe）；重定向它以便断言，路径里没有就回落 cmd.exe
    expect(windows.shell.endsWith('cmd.exe') || windows.shell.endsWith('CMD.EXE')).toBe(true)
  })

  it('没见过的平台原样显示，不编造名字', () => {
    expect(describePlatform('aix', '7.2', 'ppc64').label).toBe('AIX 7.2（aix / ppc64）')
  })
})
