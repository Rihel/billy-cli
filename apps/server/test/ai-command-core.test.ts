import { tmpdir } from 'node:os'
import { CommandRunner, type CommandResult } from '@repo/kits'
import { describe, expect, it } from 'vitest'
import { CommandCore } from '../src/modules/ai/core/command.core.js'
import { TOOL_KEYS } from '../src/modules/ai/tools/tool-keys.js'
import type { AgentTool } from '../src/modules/ai/tools/tools.types.js'

/**
 * `run-command` 的**策略**（不是机制）：开关、目录边界、时长上限。
 *
 * 机制在 `packages/kits/src/foundation/command`（那边有独立单测），这里只钉住
 * "AI 这一侧怎么把模型给的入参收窄成安全取值"—— 三条都是**安全相关**分支：
 * 关掉时不能执行、越界目录不能执行、模型传的超长超时必须被夹到配置上限。
 */
const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

const config = (over: Partial<Record<string, unknown>> = {}): never =>
  ({
    commandEnabled: true,
    commandTimeoutMs: 5_000,
    commandMaxOutputBytes: 64 * 1024,
    ...over,
  }) as never

/** 绕过模型直接执行工具（与 `ai-plan-subagents.test.ts` 的 `executeTodoWrite` 同一手法） */
const runCommand = async (core: CommandCore, input: unknown): Promise<CommandResult> => {
  const tool = core.asTools().find((item) => item.key === TOOL_KEYS.runCommand) as AgentTool
  const instance = tool.tool as unknown as {
    execute: (value: unknown, ctx: unknown) => Promise<CommandResult>
  }
  return instance.execute(input, {})
}

describe('run-command 的策略（开关 / 目录边界 / 时长上限）', () => {
  it('交出的工具 key 是 run-command，且**不是**委派类（子助手也拿得到）', () => {
    const core = new CommandCore(new CommandRunner(), config(), silentLogger)
    expect(core.key).toBe('command')
    const tools = core.asTools()
    expect(tools.map((tool) => tool.key)).toEqual([TOOL_KEYS.runCommand])
    expect(tools[0].delegation).toBeUndefined()
  })

  it('开关关掉：**不执行**命令，返回一句能读懂的结论', async () => {
    const core = new CommandCore(
      new CommandRunner(),
      config({ commandEnabled: false }),
      silentLogger,
    )
    const result = await runCommand(core, { command: 'echo should-not-run' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('已被管理员关闭')
    // 没跑 → 没有输出、没有耗时
    expect(result.stdout).toBe('')
    expect(result.durationMs).toBe(0)
  })

  it('cwd 越界：拒绝并说明边界（不静默夹回，模型必须知道自己越界了）', async () => {
    const core = new CommandCore(
      new CommandRunner(),
      config({ commandWorkDir: tmpdir() }),
      silentLogger,
    )
    const result = await runCommand(core, { command: 'echo nope', cwd: '../../' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('工作根目录')
    expect(result.stdout).toBe('')
  })

  it('cwd 在工作根目录之内：正常执行，且出参回显真实工作目录', async () => {
    const core = new CommandCore(
      new CommandRunner(),
      config({ commandWorkDir: tmpdir() }),
      silentLogger,
    )
    const result = await runCommand(core, { command: 'echo in-workdir' })
    expect(result.ok).toBe(true)
    expect(result.cwd).toBe(tmpdir())
    expect(result.stdout).toContain('in-workdir')
  })

  it('时长上限：模型传超长超时会被夹到配置上限（否则一条命令能挂住一整轮）', async () => {
    const core = new CommandCore(
      new CommandRunner(),
      config({ commandTimeoutMs: 300 }),
      silentLogger,
    )
    const startedAt = Date.now()
    // 模型要 120 秒，配置上限 300ms：必须以 300ms 为准
    const result = await runCommand(core, {
      command: 'node -e "setTimeout(function () {}, 30000)"',
      timeout_ms: 120_000,
    })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })
})
