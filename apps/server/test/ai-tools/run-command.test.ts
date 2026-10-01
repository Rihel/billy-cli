import { tmpdir } from 'node:os'
import { CommandRunner } from '@repo/kits'
import { describe, expect, it } from 'vitest'
import { RunCommandTool } from '../../src/modules/ai/core/beans/command.tool.js'
import { TOOL_KEYS } from '../../src/modules/ai/tools/tool-keys.js'
import { buildToolSpec } from '../../src/modules/ai/tools/tool.class.js'
import { buildToolStackDeps, makeToolContext, silentLogger } from '../helpers/ai-tool-stack.js'

/**
 * `run-command` 的单测（策略的完整矩阵见 `test/ai-command-core.test.ts`；
 * 这份文件是标准测试集要求的"每个工具一个测试文件"，覆盖**工具本体**）。
 */
const build = (config: Record<string, unknown> = {}) => {
  const deps = buildToolStackDeps()
  deps.source.set(TOOL_KEYS.runCommand, { config })
  const spec = buildToolSpec(new RunCommandTool(new CommandRunner(), silentLogger as never))
  return { deps, spec }
}

describe('run-command（执行命令行命令）', () => {
  it('真的执行一条跨平台命令，出参里带 exitCode / stdout / cwd', async () => {
    const { deps, spec } = build({ workDir: tmpdir() })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings })
    const result = (await spec.exec({ command: 'echo billy-tool-ok' }, ctx as never)) as {
      ok: boolean
      stdout: string
      cwd: string
      exitCode: number
    }
    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('billy-tool-ok')
    expect(result.cwd).toBe(tmpdir())
    expect(result.exitCode).toBe(0)
  })

  it('precheck：`cwd` 越界时返回一句说明（由网关翻成 precheck-failed 结论）', async () => {
    const { deps, spec } = build({ workDir: tmpdir() })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings })
    const reason = await spec.precheck?.({ command: 'ls', cwd: '../../' } as never, ctx as never)
    expect(String(reason)).toContain('工作根目录')
  })

  it('precheck：工作目录之内放行（返回 null）', async () => {
    const { deps, spec } = build({ workDir: tmpdir() })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings })
    expect(await spec.precheck?.({ command: 'ls' } as never, ctx as never)).toBeNull()
  })

  it('声明了分页（命令输出可能有几十 KB，超了就给模型一页 + 句柄）', () => {
    const { spec } = build()
    expect(spec.paginate?.pageBytes).toBeGreaterThan(0)
  })

  it('子 agent 也拿得到（不是委派类，也没有 child: deny）', () => {
    const { spec } = build()
    expect(spec.delegation).toBeUndefined()
    expect(spec.child ?? 'allow').toBe('allow')
  })
})
