import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from './agents/index.js'
import { AiController } from './ai.controller.js'
import {
  AgentConfig,
  isAgentConfigured,
  resolveAgentModel,
  type AgentConfig as AgentConfigValue,
} from './core/ai.config.js'
import { MASTRA, createMastra } from './core/ai.mastra.js'
import { AGENT_REGISTRY, createAgentRegistry } from './core/ai.registry.js'
import { AgentService } from './core/ai.service.js'
import type { AgentRegistry as AgentRegistryValue } from './core/ai.types.js'
import { AGENT_CORES, type AgentCore } from './core/ai.core.types.js'
import { PlannerCore } from './core/planner.core.js'
import { SubAgentCore } from './core/subagent.core.js'
import { createPromptEngine } from './prompts/index.js'
import {
  AgentChatService,
  AgentConversationService,
  AgentMastraStore,
  AgentRecoveryService,
  AgentRunService,
  AgentRunner,
  AgentStreamStore,
  AgentTimelineService,
  ContextService,
  ConversationRepository,
  RunRepository,
  TimelineRepository,
} from './runtime/index.js'
import { SkillLoader } from './skills/index.js'
import { CreateTodoTool } from './tools/create-todo.tool.js'
import { GetTodoTool } from './tools/get-todo.tool.js'
import { ListTodosTool } from './tools/list-todos.tool.js'
import { ToolBuilder } from './tools/tool.builder.js'
import { AGENT_TOOLS, type AgentTool } from './tools/tools.types.js'
import { AppLogger, Db } from '@repo/kits'
import { AuthModule } from '../auth/auth.module.js'
import { TodoModule } from '../todo/todo.module.js'

/**
 * 提示词引擎（单例）。
 *
 * 刻意**不进 DI 容器**：它没有依赖、也不需要被替换（要换模板目录就在测试里直接
 * `createPromptEngine({ templatesDir })`）—— 按本工程「不经容器装配的类不写装饰器」的约定，
 * 在这里做模块级单例最直白。
 */
const prompts = createPromptEngine()

/**
 * AI 模块：把 Mastra 装进 Nest 的 DI。
 *
 * 装配链路（全部在 **bootstrap 期**完成校验，坏配置起不来）：
 *   `ConfigService.get('agent')`
 *     → `AgentConfig` bean
 *     → `AGENT_TOOLS`（业务工具 bean）+ `AGENT_CORES`（core bean 的 `asTools()`）
 *     → `ToolBuilder`：把两个来源拍平成一张 key → 工具表（重复 key 直接报错）
 *     → `AgentRunner`：子 agent 执行器（core bean `subagent` 依赖它）
 *     → `SkillLoader`：加载 `skills/catalog/**`（SKILL.md 校验失败直接报错）
 *     → `AGENT_REGISTRY`：agent 声明 + 提示词模板渲染（工具清单从 ToolBuilder 注入）
 *     → `MASTRA`：`createMastra` 把 agent / 工具 / 技能装配成实例；未配置模型时注入 null
 *     → `AgentService` 查询装配结果 + `AiController` 暴露只读路由。
 *
 * 加一个 agent：`agents/<名字>.agent.ts` + `agents/index.ts` 登记 + `prompts/templates/<模板>.eta`。
 * 加一个工具：写一个 `@Injectable()` 工具 bean + 在 `AGENT_TOOLS` 的 `inject` 里加一行。
 * 加一个 core bean：写一个 `@Injectable()` 类实现 `AgentCore.asTools()` + 在 `AGENT_CORES` 登记。
 * 加一个技能：`skills/catalog/<名字>/SKILL.md`（+ 可选 `references/`）。
 */
@Module({
  imports: [AuthModule, TodoModule],
  controllers: [AiController],
  providers: [
    {
      provide: AgentConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AgentConfigValue =>
        config.getOrThrow<AgentConfigValue>('agent'),
    },
    // ---- 工具：业务工具 bean（一个工具一个 bean），这里汇总成数组（新增工具在此登记一行）----
    ListTodosTool,
    GetTodoTool,
    CreateTodoTool,
    {
      provide: AGENT_TOOLS,
      inject: [ListTodosTool, GetTodoTool, CreateTodoTool],
      useFactory: (...tools: AgentTool[]) => tools,
    },
    // ---- core bean：跨业务的运行时能力（`asTools()` 交出工具）----
    // 新增 core bean 在此登记一行：`AGENT_CORES` 汇总后由 ToolBuilder 与业务工具拍平成一张表
    AgentRunner,
    PlannerCore,
    SubAgentCore,
    {
      provide: AGENT_CORES,
      inject: [PlannerCore, SubAgentCore],
      useFactory: (...cores: AgentCore[]) => cores,
    },
    ToolBuilder,
    // ---- 技能加载器（catalog 目录默认；`SKILL_CATALOG_DIR` 为可选的覆盖 token）----
    SkillLoader,
    // ---- agent 注册表：声明 + 提示词渲染（提示词里的工具清单来自 ToolBuilder）----
    {
      provide: AGENT_REGISTRY,
      inject: [ToolBuilder],
      useFactory: (toolBuilder: ToolBuilder): AgentRegistryValue =>
        createAgentRegistry(createAgentDefinitions(prompts, toolBuilder), DEFAULT_AGENT_KEY),
    },
    // ---- Mastra 实例：未配置模型时注入 null（其余功能照常可用）----
    {
      provide: MASTRA,
      inject: [AgentConfig, AGENT_REGISTRY, ToolBuilder, SkillLoader, Db, AppLogger],
      useFactory: async (
        config: AgentConfigValue,
        registry: AgentRegistryValue,
        toolBuilder: ToolBuilder,
        skillLoader: SkillLoader,
        db: Db,
        logger: AppLogger,
      ) => {
        if (!isAgentConfigured(config)) return null
        return createMastra({
          model: resolveAgentModel(config),
          definitions: registry.all(),
          resolveTools: (ids) => toolBuilder.build(ids),
          resolveSkills: (names) => skillLoader.resolve(names),
          // 存储适配层：快照落我们自己的表（只实现 workflows 域）
          storage: new AgentMastraStore(db, logger),
          durableAgents: config.durableEnabled,
        })
      },
    },
    AgentService,
    // ---- 会话运行时：仓储 + 服务（会话增删查 / 时间线查询）----
    ConversationRepository,
    RunRepository,
    TimelineRepository,
    AgentConversationService,
    AgentTimelineService,
    AgentRunService,
    ContextService,
    AgentChatService,
    AgentStreamStore,
    AgentRecoveryService,
  ],
  exports: [
    AgentService,
    AgentRunService,
    AGENT_REGISTRY,
    ToolBuilder,
    SkillLoader,
    AgentConversationService,
    AgentTimelineService,
    AgentChatService,
    ContextService,
    AgentStreamStore,
    AgentRecoveryService,
    AgentRunner,
    ConversationRepository,
    RunRepository,
    TimelineRepository,
  ],
})
export class AiModule {}
