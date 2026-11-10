import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AppLogger, Db, RedisStore } from '@repo/kits'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from './agents/index.js'
import { AiController } from './api/ai.controller.js'
import { AiToolController } from './api/ai-tool.controller.js'
import { AiToolService } from './api/ai-tool.service.js'
import { AgentConfig, toAgentModelId, type AgentConfig as AgentConfigValue } from './core/config.js'
import { decideModelForMastra } from './core/model-decision.js'
import { AiModelModule, AiModelService } from '../ai-model/index.js'
import { MASTRA, createMastra } from './mastra/ai.mastra.js'
import { AGENT_REGISTRY, createAgentRegistry } from './agents/registry.js'
import { AgentService } from './agents/service.js'
import type { AgentRegistry as AgentRegistryValue } from './agents/types.js'
import { RunCommandTool } from './tools/command.tool.js'
import { RunSubAgentTool } from './tools/subagent.tool.js'
import { PlannerStore, PlannerTools } from './tools/planner/index.js'
import { WebTools } from './tools/web.tools.js'
import { createPromptEngine, PROMPT_ENGINE } from './core/prompts/index.js'
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
  AttachmentKeyPolicy,
  ChatAttachmentService,
  ContextService,
  ConversationRepository,
  RunRepository,
  TimelineRepository,
} from './runtime/index.js'
import {
  SKILL_DIRS,
  SKILL_LIBRARY_DIR,
  SkillLoader,
  SkillMaterializer,
} from './core/skills/index.js'
import { SkillController } from './skills/skill.controller.js'
import { SkillLibraryService } from './skills/skill.service.js'
import { SkillRepository } from './skills/skill.repository.js'
import { SkillTools } from './skills/skill.tools.js'
import { toMastraSkills } from './mastra/skill.adapter.js'
import { toMastraTools } from './mastra/tool.adapter.js'
import { AGENT_TOOL_GROUPS } from './core/tools/tools.types.js'
import { AiConnectorController } from './connectors/connector.controller.js'
import { ConnectorGuardPlugin } from './connectors/connector.guard.plugin.js'
import { CONNECTOR_STATE_SOURCE } from './connectors/connector.state.js'
import type { ConnectorStateSource } from './connectors/connector.state.js'
import { ConnectorRepository } from './connectors/connector.repository.js'
import { ConnectorService } from './connectors/connector.service.js'
import { ConnectorSyncService } from './connectors/connector.sync.service.js'
import { CONNECTOR_DRIVERS } from './connectors/connector.types.js'
import type { ConnectorDriver, ConnectorDriverMap } from './connectors/connector.types.js'
import { ConnectorStateStore } from './connectors/connector-state.store.js'
import { LarkCliDriver } from './connectors/drivers/lark-cli.driver.js'
import { RedisDriver } from './connectors/drivers/redis.driver.js'
import { SqlDriver } from './connectors/drivers/sql.driver.js'
import type { ToolEnvCaps } from './core/tools/tools.types.js'
import type { AgentToolGroup } from './core/tools/tool.class.js'
import { AGENT_TOOL_PLUGINS, ToolGateway } from './core/tools/tool.gateway.js'
import { ToolRegistry } from './core/tools/tool.registry.js'
import { ToolSeedService } from './core/tools/tool.seed.service.js'
import { ToolConfigRepository } from './core/tools/tool.config.repository.js'
import {
  TIMELINE_REPOSITORY,
  TOOL_CONFIG_SOURCE,
  TOOL_ENV_CAPS,
} from './core/tools/tool.config.ports.js'
import { ToolConfigService } from './core/tools/tool.config.service.js'
import { TOOL_CLOCK, TOOL_RATE_COUNTER } from './core/tools/tool.ports.js'
import { RedisToolRateCounter } from './core/tools/tool.rate-counter.redis.js'
import { systemToolClock } from './core/tools/tool.clock.js'
import { ToolCallMetaStore } from './core/tools/tool.meta.js'
import { ToolResultStore } from './core/tools/tool-result.store.js'
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
} from './core/tools/plugins/index.js'
import { AdminModule } from '../admin/admin.module.js'
import { AiUsageModule } from '../ai-usage/ai-usage.module.js'
import { AiMonitoringModule } from './monitoring/ai-monitoring.module.js'
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
  imports: [AuthModule, AdminModule, AiModelModule, AiUsageModule, AiMonitoringModule],
  controllers: [AiController, AiToolController, AiConnectorController, SkillController],
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
      inject: [PlannerTools, RunCommandTool, RunSubAgentTool, ReadToolResultTool, WebTools, SkillTools],
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
        web: {
          enabled: config.webEnabled,
          timeoutMsMax: config.webTimeoutMs,
          maxBytesMax: config.webMaxBytes,
          allowPrivateNetwork: config.webAllowPrivateNetwork,
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
      inject: [
        TOOL_RATE_COUNTER,
        AppLogger,
        ToolResultStore,
        TOOL_ENV_CAPS,
        ToolCallMetaStore,
        CONNECTOR_STATE_SOURCE,
      ],
      useFactory: (
        counter: RedisToolRateCounter,
        logger: AppLogger,
        results: ToolResultStore,
        caps: ToolEnvCaps,
        metas: ToolCallMetaStore,
        connectorStates: ConnectorStateSource,
      ) => [
        new EnabledPlugin(),
        // 连接器总闸：实例停用 / 缺密钥时拒绝调用（设计 §3.9）
        new ConnectorGuardPlugin(connectorStates),
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

    // ───────────────────────── 连接器（外部能力来源）─────────────────────────
    // 驱动是代码、实例是数据：驱动表在这里装配（加一种接法 = 加一个 provider + 一行）
    ConnectorStateStore,
    SqlDriver,
    RedisDriver,
    LarkCliDriver,
    {
      provide: CONNECTOR_DRIVERS,
      inject: [SqlDriver, RedisDriver, LarkCliDriver],
      useFactory: (
        sql: SqlDriver,
        redis: RedisDriver,
        larkCli: LarkCliDriver,
      ): ConnectorDriverMap =>
        new Map<string, ConnectorDriver>([
          [sql.kind, sql],
          [redis.kind, redis],
          [larkCli.kind, larkCli],
        ]),
    },
    ConnectorRepository,
    ConnectorService,
    { provide: CONNECTOR_STATE_SOURCE, useExisting: ConnectorService },
    ConnectorSyncService,

    // ───────────────────────── 工具组（运行时能力） ─────────────────────────
    AgentRunner,
    PlannerStore,
    PlannerTools,
    RunCommandTool,
    RunSubAgentTool,
    ReadToolResultTool,
    WebTools,
    SkillTools,

    // ───────────────────────── 技能库（DB 是事实源，落盘给 Mastra）─────────────────────────
    // 额外技能目录：配置 → loader（loader 只管扫目录，不认配置从哪来）
    {
      provide: SKILL_DIRS,
      inject: [AgentConfig],
      useFactory: (config: AgentConfigValue): readonly string[] => config.skillsDirs,
    },
    {
      provide: SKILL_LIBRARY_DIR,
      inject: [AgentConfig],
      useFactory: (config: AgentConfigValue): string => config.skillsLibraryDir,
    },
    {
      provide: SkillMaterializer,
      inject: [AppLogger, AgentConfig],
      useFactory: (logger: AppLogger, config: AgentConfigValue): SkillMaterializer =>
        new SkillMaterializer(logger, config.skillsLibraryDir),
    },
    SkillRepository,
    SkillLibraryService,
    SkillLoader,

    // ───────────────────────── agent 注册表与 Mastra 实例 ─────────────────────────
    {
      provide: AGENT_REGISTRY,
      // 只做声明 → 定义；技能 `'*'` 原样保留，由 `SkillLoader.resolve('*')` 在运行期现算
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
          // 授权清单在这里展开（具体 key / `'*'` / `{ category }` / `{ connector }`）：
          // 连接器产出的工具是运行期出现的，且作用域要按这一次的身份过滤 —— 没授权的工具不出现
          resolveTools: async (ids, caller) => {
            const keys = tools.expand(ids)
            const allowed = caller ? await tools.authorized(keys, caller) : keys
            return toMastraTools(tools.toolbox(allowed), logger)
          },
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
    SkillLibraryService,
    AgentConversationService,
    AgentTimelineService,
    AgentRunService,
    ContextService,
    ChatAttachmentService,
    AttachmentKeyPolicy,
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
