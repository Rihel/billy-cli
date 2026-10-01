import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import type { INestApplicationContext } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadServerAppConfig } from '../src/app-config.js'
import { RootModule } from '../src/root.module.js'
import { AiModule } from '../src/modules/ai/ai.module.js'
import { ToolRegistry } from '../src/modules/ai/tools/tool.registry.js'

/**
 * **组合根启动冒烟**（这一条是被两个真实 bug 逼出来的）。
 *
 * 为什么必须有它：单测都**手工装配**（`new ToolGateway(...)` / `new ToolRegistry(...)`），
 * 不走 Nest 容器，于是下面两类错误在单测里全绿、**只有真正启动时才炸**：
 *
 * 1. `exports` 里写了没在 `providers` 里提供的 token → `UnknownExportException`；
 * 2. **工厂型 provider 成环** → Nest **不报错、直接静默死锁**（实测：进程 CPU 0%）
 *    —— 踩过一次：`ToolRegistry → AGENT_TOOL_GROUPS → RunSubAgentTool → AgentRunner → ToolRegistry`。
 *
 * 这里只**编译并 init**（不 listen 端口）：init 会跑 `onModuleInit` / `onApplicationBootstrap`，
 * 于是 DB 初始化、种子对账、路由映射这些真实链路都被覆盖一次，跑完立刻 close。
 * 需要本机 PostgreSQL 与 Redis（与本目录其它 e2e 同一前提）。
 */
describe('组合根启动冒烟（AI 模块装配）', () => {
  let app: INestApplicationContext | null = null

  beforeAll(async () => {
    // 与 main.ts 同一条配置链路：先加载校验应用配置，再建容器
    await loadServerAppConfig()
    // 不 listen 端口：只要能 create 出来，装配（含 onApplicationBootstrap 与种子对账）就算过
    app = await NestFactory.createApplicationContext(RootModule, { logger: false })
  }, 60_000)

  afterAll(async () => {
    await app?.close()
  })

  it('容器起来了，AI 模块在册（装配无环、无未提供的导出）', () => {
    expect(app).not.toBeNull()
    expect(app?.get(AiModule)).toBeInstanceOf(AiModule)
  })

  it('注册机可用：读得到工具清单与生效配置（种子对账已跑过）', async () => {
    const registry = app?.get(ToolRegistry) as ToolRegistry
    const keys = registry.keys()
    expect(keys.length).toBeGreaterThan(0)
    const settings = await registry.settings(keys[0])
    // 三个月一过，配置表里应当有这一行（种子写进去的），所以版本不是 `code-default`
    expect(settings.version).not.toBe('code-default')
  })
})
