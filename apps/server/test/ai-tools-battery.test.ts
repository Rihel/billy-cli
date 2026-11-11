import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CommandRunner } from '@repo/kits'
import { describe, expect, it } from 'vitest'
import {
  TOOL_CALL_REASON_DESCRIPTION,
  TOOL_CALL_REASON_FIELD,
  TOOL_CALL_REASON_MAX,
  TOOL_CALL_REASON_MIN,
  withCallReason,
} from '../src/modules/ai/core/tools/call-reason.js'
import { toJsonSchema } from '../src/modules/ai/core/tools/tool.schema.js'
import { BashTool } from '../src/modules/ai/tools/bash.tool.js'
import { WebTools } from '../src/modules/ai/tools/web.tools.js'
import { FileTools } from '../src/modules/ai/files/file.tools.js'
import { PlannerStore, PlannerTools } from '../src/modules/ai/tools/planner/index.js'
import { RunSubAgentTool } from '../src/modules/ai/tools/subagent.tool.js'
import { ReadToolResultTool } from '../src/modules/ai/tools/read-tool-result.tool.js'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { ToolRegistry } from '../src/modules/ai/core/tools/tool.registry.js'
import { TOOL_KEYS } from '../src/modules/ai/core/tools/tool-keys.js'
import type { ToolEnvCaps, ToolSpec } from '../src/modules/ai/core/tools/tools.types.js'
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
    new BashTool(new CommandRunner(), silentLogger as never),
    new RunSubAgentTool(runnerLike as never, silentLogger as never),
    new ReadToolResultTool(deps.results, deps.counter, deps.caps),
    new WebTools(silentLogger as never),
    new FileTools({} as never, { enabled: true } as never),
  ]
  const registry = new ToolRegistry(groups, gateway, deps.config)
  return { deps, registry, groups }
}

const registeredSpecs = (): ToolSpec[] => buildRegistry().registry.specs()

/**
 * 每个工具的**一份合法业务入参**（用于验证"给模型的那一份"确实多要一个 `reason`）。
 *
 * 刻意写成一张按 key 索引的表：工具的入参定义一改，这里就会当场变红
 * （`spec.params.safeParse(template)` 先失败），于是这张表不会静默过期 ——
 * 标准测试集要的正是"对**每个**注册工具"的同一条断言，所以模板也必须每个工具都有。
 */
const VALID_INPUT_TEMPLATES: Record<string, Record<string, unknown>> = {
  [TOOL_KEYS.planCreate]: { goal: '整理周报', tasks: [{ title: '取待办' }] },
  [TOOL_KEYS.planReorder]: { updates: [{ id: 't1', status: 'in_progress' }] },
  [TOOL_KEYS.planComplete]: { ids: ['t1'] },
  [TOOL_KEYS.planDelete]: { ids: ['t1'] },
  [TOOL_KEYS.bash]: { command: 'echo hello' },
  [TOOL_KEYS.runSubAgent]: { name: '统计', system_prompt: '你是统计助手', task: '统计待办' },
  [TOOL_KEYS.readToolResult]: { handle: 'handle-1' },
  [TOOL_KEYS.webSearch]: { query: 'DeepSeek 搜索 API 文档' },
  [TOOL_KEYS.webFetch]: { url: 'https://example.com/docs' },
  [TOOL_KEYS.webRequest]: { url: 'https://example.com/api/list' },
  [TOOL_KEYS.fileSubmit]: { filePath: 'notes.md', fileKey: 'reports/notes.md' },
  [TOOL_KEYS.fileDownload]: { fileKey: 'uploads/abc.md' },
  [TOOL_KEYS.fileList]: {},
  [TOOL_KEYS.readFile]: { filePath: 'notes.md' },
  [TOOL_KEYS.fileSearch]: { keywords: '计费 规则' },
  [TOOL_KEYS.workspaceFiles]: {},
  [TOOL_KEYS.writeFile]: { filePath: 'notes.md', content: 'hello' },
  [TOOL_KEYS.replaceFile]: { filePath: 'notes.md', oldText: 'a', newText: 'b' },
  [TOOL_KEYS.appendFile]: { filePath: 'notes.md', content: 'hello' },
}

/** 一次合法调用要写的理由（长度过 `minLength`） */
const VALID_REASON = '用户要看这台机器的环境，所以跑这条命令'

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

  it('参数定义是 zod schema（可 safeParse）', () => {
    for (const spec of registeredSpecs()) {
      expect(typeof spec.params.safeParse, spec.key).toBe('function')
    }
  })

  /**
   * **必填 `reason`**（设计 §5.18）：给模型的 JSON Schema 里必须有 `reason`，且必须进 `required`。
   *
   * 这条是"引擎级注入"的验收点：它保证**以后新加的工具自动也有**（工具作者不用自己写），
   * 漏了就是引擎被改坏了，而不是某个工具忘了。
   */
  it('引擎注入：任何参数定义包上 `withCallReason` 后，schema 里 `reason` 必填', () => {
    for (const spec of registeredSpecs()) {
      const withReason = withCallReason(spec.params)
      const schema = withReason.toJSONSchema() as {
        properties?: Record<string, Record<string, unknown>>
        required?: string[]
      }
      const field = (schema.properties ?? {})[TOOL_CALL_REASON_FIELD] ?? {}
      expect(field.type, `${spec.key} 的 reason 不是字符串`).toBe('string')
      expect(field.minLength, spec.key).toBe(TOOL_CALL_REASON_MIN)
      expect(field.maxLength, spec.key).toBe(TOOL_CALL_REASON_MAX)
      expect(field.description, spec.key).toBe(TOOL_CALL_REASON_DESCRIPTION)
      // 无论原定义的 required 是什么，`reason` 都必须在里面
      expect(schema.required ?? [], `${spec.key} 的 reason 没进 required`).toContain(
        TOOL_CALL_REASON_FIELD,
      )
      // 缺 reason 一定不合法（原定义之外的新约束确实生效了）
      expect(withReason.safeParse({}).success, spec.key).toBe(false)
    }
  })

  it('每个注册工具都拿得到"给模型看的那一份"（`modelParams` = 原定义 + 必填 reason）', () => {
    for (const spec of registeredSpecs()) {
      const model = spec.modelParams
      expect(model, `${spec.key} 没有 modelParams（引擎没注入 reason）`).toBeDefined()
      // 后台镜像（`toJsonSchema`）与给模型的那一份必须是同一份数据结构
      expect(toJsonSchema(spec), `${spec.key} 的后台镜像少了 reason`).toEqual(
        withCallReason(spec.params).toJSONSchema(),
      )
      const template = VALID_INPUT_TEMPLATES[spec.key]
      expect(template, `标准测试集缺少 ${spec.key} 的合法入参模板`).toBeDefined()
      // 模板必须是**合法业务入参**（模板过期时在这里当场变红）
      expect(
        spec.params.safeParse(template).success,
        `${spec.key} 的入参模板已过期（原定义不认它）`,
      ).toBe(true)
      // 给模型的那一份：原入参 + reason 才行，只给原入参会被拒
      expect(model?.safeParse(template).success, `${spec.key} 缺 reason 应当被拒`).toBe(false)
      expect(
        model?.safeParse({ ...template, [TOOL_CALL_REASON_FIELD]: VALID_REASON }).success,
        `${spec.key} 给了 reason 应当通过`,
      ).toBe(true)
    }
  })

  it('配置默认值给全了：`config.parse({})` 必须成功（规范：所有配置都要有默认值）', () => {
    for (const spec of registeredSpecs()) {
      const parsed = spec.config.safeParse({})
      expect(parsed.success, `${spec.key} 的 config 缺少默认值`).toBe(true)
    }
  })

  it('秘钥定义（若有）不能带默认值：`secrets.parse({})` 必须成功且不产出明文', () => {
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

  it('子 agent 没有问答能力：问答工具不进子 agent 工具面', () => {
    // `ask-user-questions` 是 Mastra 原生工具，只挂在主 agent 上（见 mastra/ai.mastra.ts）。
    // 将来若把它迁进注册机，这条会红 —— 必须显式 `child: 'deny'`：
    // 子 agent 是临时执行体、没人能回答它，缺信息只能把问题交回主 agent。
    const { registry } = buildRegistry()
    expect([...registry.childToolbox().keys()]).not.toContain('ask-user-questions')
  })

  it('装配期校验：重复 key 直接失败；工具池不能为空（一个 key 只能有一个提供者）', () => {
    const { deps } = buildRegistry()
    const gateway = new ToolGateway(deps.config, silentLogger as never, [], deps.clock)
    const dup = new BashTool(new CommandRunner(), silentLogger as never)
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

  it('env 上限的类型定义：分页上限与取页上限都是正数', () => {
    const caps: ToolEnvCaps = buildRegistry().deps.caps
    expect(caps.pageBytesMax).toBeGreaterThan(0)
    expect(caps.maxPagesPerTurnMax).toBeGreaterThan(0)
  })
})

/**
 * **说明体量护栏**（2026-10-01 加）：工具说明是**每轮请求的前缀**，长一点就按会话重复付 token。
 *
 * 判据来自实测：改前 `bash` 的说明 913 字符，其中 643 是"纪律"段，且大半是**跨工具**的
 * （先验证 / 有副作用的先确认 / 失败不要原样重试）—— 那些已上移到全局段（`partials/principles.eta`
 * 的「纪律（所有工具通用）」），工具说明只该留"是什么 / 什么时候用不用 / 自己特有的约束"。
 * 参考 DSH 自己的系统提示词：规则集中写一遍，单个工具只留一句。
 */
describe('工具说明的体量护栏', () => {
  it('每个注册工具的说明 ≤ 380 字符（论证性散文不进提示词）', () => {
    for (const spec of registeredSpecs()) {
      expect(spec.description.length, `工具 ${spec.key} 的说明过长：请把"为什么"移到设计文档`).toBeLessThanOrEqual(380)
    }
  })
})
