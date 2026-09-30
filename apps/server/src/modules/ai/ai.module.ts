import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from './agents/index.js'
import { AiController } from './ai.controller.js'
import {
  AgentConfig,
  toAgentModelId,
  type AgentConfig as AgentConfigValue,
} from './core/ai.config.js'
import { readAgentRuntime } from './core/ai.core.types.js'
import { decideModelForMastra } from './core/ai.model-decision.js'
import { AiModelModule, AiModelService } from '../ai-model/index.js'
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
import { ToolBuilder } from './tools/tool.builder.js'
import { AGENT_TOOLS, type AgentTool } from './tools/tools.types.js'
import { AppLogger, Db } from '@repo/kits'
import { AdminModule } from '../admin/admin.module.js'
import { AuthModule } from '../auth/auth.module.js'

/**
 * 提示词引擎（单例）。
 *
 * 刻意**不进 DI 容器**：它没有依赖、也不需要被替换（要换模板目录就在测试里直接
 * `createPromptEngine({ templatesDir })`）—— 按本工程「不经容器装配的类不写装饰器」的约定，
 * 在这里做模块级单例最直白。
 */
const prompts = createPromptEngine()

/**
 * 「哪些供应商走官方 SDK 适配」的**权威名单**在 `modules/ai-model/provider-adapters.ts`
 * 的 `OFFICIAL_ADAPTER_KINDS`（那边同时服务"列模型"与"跑对话"两件事）。
 *
 * 为什么用 `ai_providers.kind` 而不是 `modelRef` 的 slug 前缀判断：slug 是展示用的、人能改、
 * 还能撞名 —— 靠它判断会让官方适配在"改个 slug"之后静默失效（踩过：思考整段丢失）。
 * 加一家 = 装上它的 `@ai-sdk/<provider>`（版本要匹配 `ai@6`）并把 kind 写进那张表。
 */

/** 构造期求值动态模型时只警告一次（每个 agent 各求值一次，别刷屏） */
let warnedMissingEnvelope = false

/**
 * AI 模块：把 Mastra 装进 Nest 的 DI。
 *
 * 装配链路（全部在 **bootstrap 期**完成校验，坏配置起不来）：
 *   `ConfigService.get('agent')`
 *     → `AgentConfig` bean
 *     → `AGENT_TOOLS`（业务工具 bean，**当前为空**）+ `AGENT_CORES`（core bean 的 `asTools()`）
 *     → `ToolBuilder`：把两个来源拍平成一张 key → 工具表（重复 key 直接报错；
 *        业务工具可以为空，但 core bean 必须交出工具）
 *     → `AgentRunner`：子 agent 执行器（core bean `subagent` 依赖它）
 *     → `SkillLoader`：加载 `skills/catalog/**`（SKILL.md 校验失败直接报错）
 *     → `AGENT_REGISTRY`：agent 声明 + 提示词模板渲染（工具清单从 ToolBuilder 注入）
 *     → `MASTRA`：`createMastra` 把 agent / 工具 / 技能装配成实例；未配置模型时注入 null
 *     → `AgentService` 查询装配结果 + `AiController` 暴露只读路由。
 *
 * 加一个 agent：`agents/<名字>.agent.ts` + `agents/index.ts` 登记 + `prompts/templates/<模板>.eta`。
 * 加一个业务工具：写一个 `@Injectable()` 工具 bean + 在 `AGENT_TOOLS` 的 `inject` 里加一行。
 * 加一个 core bean：写一个 `@Injectable()` 类实现 `AgentCore.asTools()` + 在 `AGENT_CORES` 登记。
 * 加一个技能：`skills/catalog/<名字>/SKILL.md`（+ 可选 `references/`）。
 */
@Module({
  // AiModelModule 提供"这一轮用哪个模型"的真相源（模型与供应商都在库里，§4.9）
  // 不 import 任何业务模块：AI 模块与业务模块解耦（业务能力将来经 AGENT_TOOLS 以工具 bean 接入）
  // AdminModule：AiController 挂 AnyAuthGuard（前台用户 **或** 管理员），
  // 而该守卫内部依赖 AdminAuthGuard —— **守卫的依赖模块也要 import**，否则启动报 UnknownDependencies（踩过）
  imports: [AuthModule, AdminModule, AiModelModule],
  controllers: [AiController],
  providers: [
    {
      provide: AgentConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AgentConfigValue =>
        config.getOrThrow<AgentConfigValue>('agent'),
    },
    // ---- 工具：业务工具 bean 的汇总点（**当前为空**，AI 模块与业务模块解耦）----
    // 新增业务工具时：写一个 `@Injectable()` 的 tool bean + 在下面 inject 里加一行
    {
      provide: AGENT_TOOLS,
      inject: [],
      useFactory: (): AgentTool[] => [],
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
      inject: [AgentConfig, AGENT_REGISTRY, ToolBuilder, SkillLoader, Db, AppLogger, AiModelService],
      useFactory: async (
        config: AgentConfigValue,
        registry: AgentRegistryValue,
        toolBuilder: ToolBuilder,
        skillLoader: SkillLoader,
        db: Db,
        logger: AppLogger,
        models: AiModelService,
      ) => {
        return createMastra({
          /**
           * 模型**每次调用**从运行时信封里取（编排层已经从库里解析好，§4.9）。
           *
           * 这里不做任何兜底：拿不到信封说明调用没走编排层（配置错误），直接抛 ——
           * 静默回落到某个默认模型会让"agent 只能用配的模型"失效。
           */
          /**
           * 模型**每次调用**从运行时信封里取（编排层已经把这一轮的模型从库里解析好，§4.9）。
           *
           * ⚠️ **这里不能抛错**（踩过的坑）：Mastra 在 `new Mastra({ agents })` 构造 durable agent 时
           * 就会**先求值一次**动态模型（`Agent.getModel()` 要拿模型做持久化元数据），那一刻
           * `requestContext` 是空的 —— 早先在这里 throw 直接把服务启动打挂了。
           *
           * 所以：拿不到信封时返回一个**占位模型**（不会被真正用于任何请求），
           * 真正的收口在编排层：`AgentChatService.resolveRuntimeModel()` 在任何调用之前
           * 就从库里解析模型并塞进信封，解析不出来抛 3406/3402/3404，连流都不会建。
           */
          resolveModel: (_definition, requestContext) => {
            const model = readAgentRuntime(requestContext)?.model
            if (!model) {
              if (!warnedMissingEnvelope) {
                warnedMissingEnvelope = true
                logger.warn('ai.model.envelope_missing', {
                  reason:
                    '构造期或未注入运行时信封的调用（占位模型不会被真正使用；真实调用请走编排层）',
                })
              }
              // 占位：id 必须是 `provider/model` 形态；地址指向本机一个不监听的端口，
              // 万一真的被用于请求，会立刻连接失败而不是静默打到某个真实供应商上
              return {
                id: toAgentModelId('placeholder/not-configured'),
                url: 'http://127.0.0.1:1/v1',
                apiKey: 'placeholder',
              }
            }
            /**
             * **走官方适配还是通用 OpenAI 兼容**：决策在 `decideModelForMastra`（纯函数，可单测）。
             *
             * 两条硬约束（都踩过，详见那个文件的注释）：
             * - 官方适配**不能传 `url`**：传了就退化成通用兼容层，思考字段（DeepSeek 的
             *   `reasoning_content`）整段丢失，且 `agent.stream()` 的返回形态变成工作流包装对象；
             * - 判据是**供应商类型**（`ai_providers.kind`），不是 `modelRef` 的 slug 前缀。
             */
            const decision = decideModelForMastra(model)
            if (decision.ignoredBaseURL) {
              // 不静默：用户确实配了地址却被忽略，排障时"我明明配了地址"必须有据可查
              logger.warn('ai.model.base_url_ignored', {
                modelId: model.id,
                providerKind: model.providerKind,
                baseURL: decision.ignoredBaseURL,
                reason: '官方适配走 provider 自带端点（传 url 会退化成通用兼容层并丢掉思考字段）',
              })
            }
            return decision.model
          },
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
