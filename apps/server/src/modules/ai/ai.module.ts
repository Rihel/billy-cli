import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AppLogger, Db, RedisStore } from '@repo/kits'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from './agents/index.js'
import { AiController } from './ai.controller.js'
import { AiToolController } from './ai-tool.controller.js'
import { AiToolService } from './tools/ai-tool.service.js'
import { AgentConfig, toAgentModelId, type AgentConfig as AgentConfigValue } from './core/ai.config.js'
import { decideModelForMastra } from './core/ai.model-decision.js'
import { AiModelModule, AiModelService } from '../ai-model/index.js'
import { MASTRA, createMastra } from './mastra/ai.mastra.js'
import { AGENT_REGISTRY, createAgentRegistry } from './core/ai.registry.js'
import { AgentService } from './core/ai.service.js'
import type { AgentRegistry as AgentRegistryValue } from './core/ai.types.js'
import { RunCommandTool } from './core/beans/command.tool.js'
import { RunSubAgentTool } from './core/beans/subagent.tool.js'
import { PlannerStore, PlannerTools } from './core/beans/planner/index.js'
import { createPromptEngine, PROMPT_ENGINE } from './prompts/index.js'
import {
  AgentChatService,
  AgentConversationService,
  AgentMastraStore,
  AgentRecoveryService,
  AgentRunService,
  AgentRunner,
  AgentStreamStore,
  AgentTimelineService,
  AgentTitleService,
  ContextService,
  ConversationRepository,
  RunRepository,
  TimelineRepository,
} from './runtime/index.js'
import { SkillLoader } from './skills/index.js'
import { toMastraSkills } from './mastra/skill.adapter.js'
import { toMastraTools } from './mastra/tool.adapter.js'
import { AGENT_TOOL_GROUPS } from './tools/tools.types.js'
import type { ToolEnvCaps } from './tools/tools.types.js'
import type { AgentToolGroup } from './tools/tool.class.js'
import { AGENT_TOOL_PLUGINS, ToolGateway } from './tools/tool.gateway.js'
import { ToolRegistry } from './tools/tool.registry.js'
import { ToolSeedService } from './tools/tool.seed.service.js'
import { ToolConfigRepository } from './tools/tool.config.repository.js'
import {
  TIMELINE_REPOSITORY,
  TOOL_CONFIG_SOURCE,
  TOOL_ENV_CAPS,
} from './tools/tool.config.ports.js'
import { ToolConfigService } from './tools/tool.config.service.js'
import { TOOL_CLOCK, TOOL_RATE_COUNTER } from './tools/tool.ports.js'
import { RedisToolRateCounter } from './tools/tool.rate-counter.redis.js'
import { systemToolClock } from './tools/tool.clock.js'
import { ToolCallMetaStore } from './tools/tool.meta.js'
import { ToolResultStore } from './tools/tool-result.store.js'
import { ReadToolResultTool } from './tools/read-tool-result.tool.js'
import {
  AuditEndPlugin,
  AuditStartPlugin,
  EnabledPlugin,
  PaginatePlugin,
  PrecheckPlugin,
  RateLimitPlugin,
  RedactPlugin,
  ScopePlugin,
  ValidatePlugin,
} from './tools/plugins/index.js'
import { AdminModule } from '../admin/admin.module.js'
import { AuthModule } from '../auth/auth.module.js'

/**
 * 提示词引擎（单例）。
 *
 * 有**两处**消费方，所以以 value provider 的形式进容器（token `PROMPT_ENGINE`）：
 * 1. 装配期：把所有 agent 声明渲染成定义（提示词里的工具清单来自实际授权）；
 * 2. 运行期：渲染只属于**会话开局**的「运行环境」片段。
 */
const prompts = createPromptEngine()

/** 构造期求值动态模型时只警告一次（每个 agent 各求值一次，别刷屏） */
let warnedMissingEnvelope = false

/**
 * AI 模块：把 Mastra 装进 Nest 的 DI（工具侧见 `docs/design/ai-agent-tool-engine.md`）。
 *
 * 装配链路（全部在 **bootstrap 期**完成校验，坏配置起不来）：
 *   `ConfigService.get('agent')` → `AgentConfig` bean
 *     → `ToolGateway`（插件链）+ `AGENT_TOOL_GROUPS`（工具组实例数组）
 *     → `ToolRegistry`：对每个组 `buildToolSpecs()` 拍平成一张 key → 工具表（一个组 1..n 个工具）
 *       （重复 key、缺装饰器声明、默认值没给全，直接报错）
 *     → `ToolSeedService`：启动时把声明对账进 `ai_tools`（只补不覆盖人工改动）
 *     → `AGENT_REGISTRY`：agent 声明 + 提示词渲染（工具清单从注册机来，与实际挂载同源）
 *     → `MASTRA`：`createMastra` 装配实例（工具 / 技能经 `ai/mastra/**` 适配器转成 Mastra 词汇）
 *
 * 加一个 agent：`agents/<名字>.agent.ts` + `agents/index.ts` 登记 + 模板。
 * 加一个工具：在合适的工具组类里加一个 `@ToolDecl` 方法（没有合适的组就新建一个 `@ToolGroup` 类）
 * + 在 `AGENT_TOOL_GROUPS` 登记一行。
 */
@Module({
  imports: [AuthModule, AdminModule, AiModelModule],
  controllers: [AiController, AiToolController],
  providers: [
    {
      provide: AgentConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AgentConfigValue =>
        config.getOrThrow<AgentConfigValue>('agent'),
    },
    // 提示词引擎：装配期（渲染 agent 定义）与运行期（渲染开局环境片段）共用同一个实例
    { provide: PROMPT_ENGINE, useValue: prompts },

    // ───────────────────────── 工具引擎（主体） ─────────────────────────
    // 工具组实例（**唯一的工具来源**）：注册机对每个组跑 `buildToolSpecs()` 拿 1..n 个工具
    {
      provide: AGENT_TOOL_GROUPS,
      inject: [PlannerTools, RunCommandTool, RunSubAgentTool, ReadToolResultTool],
      useFactory: (...groups: AgentToolGroup[]): AgentToolGroup[] => groups,
    },
    // 部署上限（env）：库里的值再大也突破不了
    {
      provide: TOOL_ENV_CAPS,
      inject: [AgentConfig],
      useFactory: (config: AgentConfigValue): ToolEnvCaps => ({
        pageBytesMax: config.toolPageBytesMax,
        maxPagesPerTurnMax: config.toolMaxPagesPerTurnMax,
        command: {
          enabled: config.commandEnabled,
          timeoutMsMax: config.commandTimeoutMs,
          maxOutputBytesMax: config.commandMaxOutputBytes,
          ...(config.commandWorkDir ? { workDir: config.commandWorkDir } : {}),
        },
      }),
    },
    { provide: TOOL_CLOCK, useValue: systemToolClock },
    ToolCallMetaStore,
    ToolConfigRepository,
    { provide: TOOL_CONFIG_SOURCE, useExisting: ToolConfigRepository },
    { provide: TIMELINE_REPOSITORY, useExisting: TimelineRepository },
    { provide: TOOL_RATE_COUNTER, inject: [RedisStore], useFactory: (redis: RedisStore) => new RedisToolRateCounter(redis) },
    ToolResultStore,
    ToolConfigService,
    // 网关插件链：**数组顺序 = 执行顺序**（redact → paginate → audit-end 不能换）
    {
      provide: AGENT_TOOL_PLUGINS,
      inject: [TOOL_RATE_COUNTER, AppLogger, ToolResultStore, TOOL_ENV_CAPS, ToolCallMetaStore],
      useFactory: (
        counter: RedisToolRateCounter,
        logger: AppLogger,
        results: ToolResultStore,
        caps: ToolEnvCaps,
        metas: ToolCallMetaStore,
      ) => [
        new EnabledPlugin(),
        new ScopePlugin(),
        new RateLimitPlugin(counter, logger),
        new ValidatePlugin(),
        new PrecheckPlugin(),
        new AuditStartPlugin(),
        new RedactPlugin(logger),
        new PaginatePlugin(results, caps, logger),
        new AuditEndPlugin(metas, logger),
      ],
    },
    ToolGateway,
    ToolRegistry,
    ToolSeedService,

    // ───────────────────────── 工具组（运行时能力） ─────────────────────────
    AgentRunner,
    PlannerStore,
    PlannerTools,
    RunCommandTool,
    RunSubAgentTool,
    ReadToolResultTool,

    // ───────────────────────── agent 注册表与 Mastra 实例 ─────────────────────────
    SkillLoader,
    {
      provide: AGENT_REGISTRY,
      inject: [ToolRegistry],
      useFactory: (registry: ToolRegistry): AgentRegistryValue =>
        createAgentRegistry(createAgentDefinitions(prompts, registry), DEFAULT_AGENT_KEY),
    },
    {
      provide: MASTRA,
      inject: [AgentConfig, AGENT_REGISTRY, ToolRegistry, SkillLoader, Db, AppLogger, AiModelService],
      useFactory: async (
        config: AgentConfigValue,
        registry: AgentRegistryValue,
        tools: ToolRegistry,
        skillLoader: SkillLoader,
        db: Db,
        logger: AppLogger,
        models: AiModelService,
      ) => {
        return createMastra({
          /**
           * 模型**每次调用**从运行时信封里取（编排层已经从库里解析好）。
           *
           * 这里不做兜底：真实调用的收口在编排层（`AgentChatService.resolveRuntimeModel`），
           * 解析不出来抛 3406/3402/3404，连流都不会建；构造期拿不到信封时由适配器给占位模型。
           */
          resolveModel: (_definition, model) => {
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
          resolveTools: (ids) => toMastraTools(tools.toolbox(ids), logger),
          resolveSkills: async (names) => toMastraSkills(await skillLoader.resolve(names)),
          storage: new AgentMastraStore(db, logger),
          durableAgents: config.durableEnabled,
          onMissingEnvelope: () => {
            if (warnedMissingEnvelope) return
            warnedMissingEnvelope = true
            logger.warn('ai.model.envelope_missing', {
              reason:
                '构造期或未注入运行时信封的调用（占位模型不会被真正使用；真实调用请走编排层）',
            })
          },
        })
      },
    },

    // ---- 会话运行时：仓储（服务都注入它们；漏了就在启动时 UnknownDependencies）----
    ConversationRepository,
    RunRepository,
    TimelineRepository,
    AgentService,
    AiToolService,
    AgentConversationService,
    AgentTimelineService,
    AgentRunService,
    ContextService,
    AgentChatService,
    AgentTitleService,
    AgentStreamStore,
    AgentRecoveryService,
  ],
  exports: [
    AgentService,
    AiToolService,
    AgentRunService,
    AGENT_REGISTRY,
    ToolRegistry,
    ToolGateway,
    ToolConfigService,
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
