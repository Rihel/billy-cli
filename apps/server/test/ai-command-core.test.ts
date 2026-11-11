import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandRunner, type CommandResult } from '@repo/kits'
import { describe, expect, it } from 'vitest'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { BashTool } from '../src/modules/ai/tools/bash.tool.js'
import { TOOL_KEYS } from '../src/modules/ai/core/tools/tool-keys.js'
import type { ToolCallContext, ToolEnvCaps, ToolSpec } from '../src/modules/ai/core/tools/tools.types.js'
import {
  buildToolStackDeps,
  silentLogger,
  specByKey,
  TEST_TOOL_ENV_CAPS,
} from './helpers/ai-tool-stack.js'

/**
 * `bash` 的**策略**（不是机制）：开关、目录边界、时长上限。
 *
 * 机制在 `packages/kits/src/foundation/command`（那边有独立单测），这里只钉住
 * "AI 这一侧怎么把模型给的入参收窄成安全取值"。
 *
 * 改造后（设计 §5.9）测试**直接调声明的 `exec`**（不再从 `createTool` 产物里抠 `execute`、也不造
 * `RequestContext`）：策略里的开关与目录边界移到了网关插件与 `normalize`，所以这里同时测：
 * - `normalize`：把库里的配置夹到部署上限（env）；
 * - `precheck`：目录越界拒绝并说明；
 * - `exec`：真跑命令时的时长夹紧与出参形状。
 */
const testEnvelope = {
  conversationId: 'conv-test',
  parentRunId: 'run-test',
  triggeredBy: 'user-test',
  isAdmin: false,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  depth: 0,
} as never

const buildStack = (
  options: {
    sourceRows?: Record<string, Record<string, unknown>>
    /** 部署上限覆盖（测"env 没配这一项"等情形；缺省 `TEST_TOOL_ENV_CAPS`） */
    caps?: ToolEnvCaps
  } = {},
) => {
  const deps = buildToolStackDeps(options.caps ? { caps: options.caps } : {})
  for (const [key, row] of Object.entries(options.sourceRows ?? {})) {
    deps.source.set(key, row as never)
  }
  const gateway = new ToolGateway(deps.config, silentLogger as never, deps.plugins, deps.clock)
  const caps = options.caps ?? TEST_TOOL_ENV_CAPS
  const spec = specByKey(
    new BashTool(new CommandRunner(), silentLogger as never, caps),
    TOOL_KEYS.bash,
  )
  return { deps, gateway, spec }
}

/** 造一次调用的上下文（测试不需要 Mastra） */
const contextFor = async (
  deps: ReturnType<typeof buildToolStackDeps>,
  spec: ToolSpec,
  input: unknown,
): Promise<ToolCallContext> => ({
  spec,
  toolKey: spec.key,
  toolCallId: 'call-test',
  caller: {
    conversationId: 'conv-test',
    runId: 'run-test',
    userId: 'user-test',
    isAdmin: false,
    agentKey: 'assistant',
    rootAgentKey: 'assistant',
    depth: 0,
  },
  settings: await deps.config.settings(spec),
  envelope: null,
  log: silentLogger as never,
  clock: deps.clock,
  rawInput: input,
  input,
})

describe('bash 的策略（开关 / 目录边界 / 时长上限）', () => {
  it('交出的声明 key 是 bash，且**不是**委派类（子助手也拿得到）', () => {
    const { spec } = buildStack()
    expect(spec.key).toBe(TOOL_KEYS.bash)
    expect(spec.delegation).toBeUndefined()
    // 子 agent 工具面里要有它
    expect(spec.child ?? 'allow').toBe('allow')
  })

  it('配置默认值：15 秒 / 64KB / 开关打开（每个配置项都有默认值，库里没行也能跑）', () => {
    const { deps, spec } = buildStack()
    return deps.config.settings(spec).then((settings) => {
      expect(settings.config).toMatchObject({
        enabled: true,
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024,
      })
    })
  })

  it('normalize：库里的值再大也被夹到 env 上限（部署边界不可突破）', async () => {
    const { deps, spec } = buildStack({
      sourceRows: {
        [TOOL_KEYS.bash]: {
          config: { timeoutMs: 600_000, maxOutputBytes: 10 * 1024 * 1024 },
        },
      },
    })
    const settings = await deps.config.settings(spec)
    expect(settings.config.timeoutMs).toBe(TEST_TOOL_ENV_CAPS.command?.timeoutMsMax)
    expect(settings.config.maxOutputBytes).toBe(TEST_TOOL_ENV_CAPS.command?.maxOutputBytesMax)
  })

  it('开关关掉（配置表）：网关短路，**不执行**命令', async () => {
    const { deps, gateway, spec } = buildStack({
      sourceRows: { [TOOL_KEYS.bash]: { enabled: false } },
    })
    const outcome = await gateway.invoke(spec, { command: 'echo should-not-run', reason: '验证开关关掉时不会真的执行命令' }, {
      callId: 'call-1',
      envelope: null,
      log: silentLogger as never,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('应当被拒绝')
    expect(outcome.reason).toBe('disabled')
    expect(deps.metas).toBeDefined()
  })

  it('开关关掉（能力级 config.enabled）：同样不执行', async () => {
    const { deps, gateway, spec } = buildStack({
      sourceRows: { [TOOL_KEYS.bash]: { config: { enabled: false } } },
    })
    const outcome = await gateway.invoke(spec, { command: 'echo should-not-run', reason: '验证开关关掉时不会真的执行命令' }, {
      callId: 'call-2',
      envelope: null,
      log: silentLogger as never,
    })
    expect(outcome.ok).toBe(false)
  })

  it('cwd 越界：precheck 拒绝并说明边界（不静默夹回，模型必须知道自己越界了）', async () => {
    const { deps, gateway, spec } = buildStack({
      caps: {
        ...TEST_TOOL_ENV_CAPS,
        command: { ...TEST_TOOL_ENV_CAPS.command!, workDir: tmpdir() },
      },
    })
    const outcome = await gateway.invoke(spec, { command: 'echo nope', cwd: '../../', reason: '验证目录越界会被拒绝' }, {
      callId: 'call-3',
      envelope: null,
      log: silentLogger as never,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('应当被拒绝')
    expect(outcome.reason).toBe('precheck-failed')
    expect(outcome.message).toContain('本会话工作区')
  })

  it('cwd 在工作根目录之内：正常执行，且出参回显真实工作目录', async () => {
    const { deps, gateway, spec } = buildStack({
      caps: {
        ...TEST_TOOL_ENV_CAPS,
        command: { ...TEST_TOOL_ENV_CAPS.command!, workDir: tmpdir() },
      },
    })
    const outcome = await gateway.invoke(spec, { command: 'echo in-workdir', reason: '验证工作目录之内可以正常执行' }, {
      callId: 'call-4',
      envelope: testEnvelope,
      log: silentLogger as never,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('应当成功')
    const result = outcome.data as CommandResult
    expect(result.cwd).toBe(join(tmpdir(), 'conv-test'))
    expect(result.stdout).toContain('in-workdir')
  })

  it('时长上限：模型传超长超时会被夹到配置上限（否则一条命令能挂住一整轮）', async () => {
    const { deps, gateway, spec } = buildStack({
      sourceRows: { [TOOL_KEYS.bash]: { config: { timeoutMs: 300 } } },
    })
    const startedAt = Date.now()
    // 模型要 120 秒，配置上限 300ms：必须以 300ms 为准
    const outcome = await gateway.invoke(
      spec,
      { command: 'node -e "setTimeout(function () {}, 30000)"', timeout_ms: 120_000, reason: '验证超长超时会被夹到配置上限' },
      { callId: 'call-5', envelope: null, log: silentLogger as never },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('应当返回结论（超时也是结论）')
    const result = outcome.data as CommandResult
    // 超时是**结论**不是异常：出参里带 timedOut，且整轮不受影响
    expect(result.timedOut).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(await contextFor(deps, spec, {})).toBeDefined()
  })
})
