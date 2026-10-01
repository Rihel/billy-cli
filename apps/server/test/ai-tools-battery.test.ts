import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CommandRunner } from '@repo/kits'
import { describe, expect, it } from 'vitest'
import { RunCommandTool } from '../src/modules/ai/core/beans/command.tool.js'
import { PlannerStore, PlannerTools } from '../src/modules/ai/core/beans/planner/index.js'
import { RunSubAgentTool } from '../src/modules/ai/core/beans/subagent.tool.js'
import { ReadToolResultTool } from '../src/modules/ai/tools/read-tool-result.tool.js'
import { ToolGateway } from '../src/modules/ai/tools/tool.gateway.js'
import { ToolRegistry } from '../src/modules/ai/tools/tool.registry.js'
import { TOOL_KEYS } from '../src/modules/ai/tools/tool-keys.js'
import type { ToolEnvCaps, ToolSpec } from '../src/modules/ai/tools/tools.types.js'
import { buildToolStackDeps, silentLogger } from './helpers/ai-tool-stack.js'

/**
 * **注册机标准测试集**（设计 §5.9）：对注册机里的**每一个**工具跑同一组断言。
 *
 * 为什么要有它：工具会越加越多，而"每个工具都写了测试"靠自觉守不住。
 * 这里做两件事：
 * 1. **结构不变量**：key / 说明 / 配置默认值 / 子 agent 面 —— 漏了当场红；
 * 2. **文件存在性**：每个 key 必须有 `test/ai-tools/<key>.test.ts`（标准测试集保证"能测"，
 *    这条保证"确实写了"）。
 */
const buildRegistry = () => {
  const deps = buildToolStackDeps()
  const gateway = new ToolGateway(deps.config, silentLogger as never, deps.plugins, deps.clock)
  // runner / timeline 只做"在册判定"与"读计划"，这里给最小替身（工具本体另有专测）
  const timelinesLike = {
    latestPlan: async () => null,
    findToolOutput: async () => null,
  }
  const runnerLike = { runSubAgent: async () => ({ status: 'succeeded' }) }
  // 工具组实例数组（`AGENT_TOOL_GROUPS` 的语义）：注册机对每个组 `buildToolSpecs()` 拿 1..n 个工具
  const store = new PlannerStore(timelinesLike as never)
  const groups = [
    new PlannerTools(store),
    new RunCommandTool(new CommandRunner(), silentLogger as never),
    new RunSubAgentTool(runnerLike as never, silentLogger as never),
    new ReadToolResultTool(deps.results, deps.counter, deps.caps),
  ]
  const registry = new ToolRegistry(groups, gateway, deps.config)
  return { deps, registry, groups }
}

const registeredSpecs = (): ToolSpec[] => buildRegistry().registry.specs()

describe('注册机标准测试集（对每个注册工具）', () => {
  it('注册机里有工具（运行时能力至少要交出工具，否则 agent 连"能干什么"都没有）', () => {
    expect(registeredSpecs().length).toBeGreaterThan(0)
  })

  it('每个 key 都在 `TOOL_KEYS` 里（不写裸字符串）', () => {
    const known = new Set<string>(Object.values(TOOL_KEYS))
    for (const spec of registeredSpecs()) expect(known.has(spec.key), spec.key).toBe(true)
  })

  it('结构：key / 标题 / 说明 / 类别都合法，说明是**能给模型看**的一段话', () => {
    for (const spec of registeredSpecs()) {
      expect(spec.key.trim().length, spec.key).toBeGreaterThan(0)
      expect(spec.title.trim().length, spec.key).toBeGreaterThan(0)
      // 说明太短说明没写"什么时候用 / 什么时候不用"（本工程的说明纪律）
      expect(spec.description.length, `${spec.key} 的说明太短`).toBeGreaterThan(60)
      expect(['core', 'business']).toContain(spec.category)
    }
  })

  it('参数契约是 zod schema（可 safeParse）', () => {
    for (const spec of registeredSpecs()) {
      expect(typeof spec.params.safeParse, spec.key).toBe('function')
    }
  })

  it('配置默认值给全了：`config.parse({})` 必须成功（铁律：所有配置都要有默认值）', () => {
    for (const spec of registeredSpecs()) {
      const parsed = spec.config.safeParse({})
      expect(parsed.success, `${spec.key} 的 config 缺少默认值`).toBe(true)
    }
  })

  it('秘钥契约（若有）不能带默认值：`secrets.parse({})` 必须成功且不产出明文', () => {
    for (const spec of registeredSpecs()) {
      if (!spec.secrets) continue
      const parsed = spec.secrets.safeParse({})
      expect(parsed.success, `${spec.key} 的 secrets 不该要求必填`).toBe(true)
      expect(parsed.data).toEqual({})
    }
  })

  it('声明了分页的工具，页大小必须是正数', () => {
    for (const spec of registeredSpecs()) {
      if (!spec.paginate) continue
      expect(spec.paginate.pageBytes, spec.key).toBeGreaterThan(0)
    }
  })

  it('子 agent 面的规则自洽：委派类工具一定不许子 agent 用', () => {
    for (const spec of registeredSpecs()) {
      if (spec.delegation === true) {
        expect(spec.child, `${spec.key} 是委派类，必须 child: deny`).toBe('deny')
      }
    }
  })

  it('`toolbox(keys)` 只给请求的那几个 key', () => {
    const { registry } = buildRegistry()
    const keys = registry.keys().slice(0, 2)
    expect([...registry.toolbox(keys).keys()]).toEqual(keys)
    expect(() => registry.toolbox(['not-registered'])).toThrowError(/未知的工具 key/)
  })

  it('`childToolbox()` = 全部 − 委派类 − `child: deny`（排除法，不是白名单）', () => {
    const { registry } = buildRegistry()
    const child = new Set(registry.childToolbox().keys())
    for (const spec of registry.specs()) {
      if (spec.delegation === true || spec.child === 'deny') {
        expect(child.has(spec.key), `${spec.key} 不该出现在子 agent 工具面`).toBe(false)
      } else {
        expect(child.has(spec.key), `${spec.key} 应该出现在子 agent 工具面`).toBe(true)
      }
    }
  })

  it('装配期校验：重复 key 直接失败；工具池不能为空（一个 key 只能有一个提供者）', () => {
    const { deps } = buildRegistry()
    const gateway = new ToolGateway(deps.config, silentLogger as never, [], deps.clock)
    const dup = new RunCommandTool(new CommandRunner(), silentLogger as never)
    expect(() => new ToolRegistry([dup, dup], gateway, deps.config)).toThrowError(/工具 key 重复/)
    // 工具池不能为空 —— 否则 agent 连"能干什么"都没有
    expect(() => new ToolRegistry([], gateway, deps.config)).toThrowError(/工具池不能为空/)
  })

  it('每个注册工具都有对应的测试文件（`test/ai-tools/<key>.test.ts`）', () => {
    const dir = join(import.meta.dirname, 'ai-tools')
    for (const spec of registeredSpecs()) {
      const file = join(dir, `${spec.key}.test.ts`)
      expect(existsSync(file), `缺少测试文件：test/ai-tools/${spec.key}.test.ts`).toBe(true)
    }
  })

  it('env 上限的类型契约：分页上限与取页上限都是正数', () => {
    const caps: ToolEnvCaps = buildRegistry().deps.caps
    expect(caps.pageBytesMax).toBeGreaterThan(0)
    expect(caps.maxPagesPerTurnMax).toBeGreaterThan(0)
  })
})
