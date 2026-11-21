import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AppLogger, Db, RedisStore } from '@repo/kits'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from './agents/index.js'
import { AgentInternalController } from './api/agent-internal.controller.js'
import { AgentConfig, type AgentConfig as AgentConfigValue } from './core/config.js'
import { decideModelForMastra } from './core/model-decision.js'
import { MASTRA, createMastra } from './mastra/ai.mastra.js'
import {
  AGENT_MEMORY,
  createAgentMemory,
  createInMemoryAgentMemory,
} from './mastra/agent-memory.js'
import { AGENT_REGISTRY, createAgentRegistry } from './agents/registry.js'
import { AgentService } from './agents/service.js'
import type { AgentRegistry as AgentRegistryValue } from './agents/types.js'
import { RunSubAgentTool } from './tools/subagent.tool.js'
import { PlannerStore, PlannerTools } from './tools/planner/index.js'
import { createPromptEngine, PROMPT_ENGINE } from './core/prompts/index.js'
import { ModelGatewayCatalogService } from './runtime/model-gateway.catalog.js'
import { RUNTIME_MODEL_RESOLVER } from './runtime/model-resolver.js'
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
  RunStatusStream,
  RUN_STATUS_LISTENER,
  SubAgentResultWriter,
  TimelineRepository,
} from './runtime/index.js'
import { createRemoteToolInvoker } from './runtime/remote-tool.client.js'
import { GatewayToolCatalog } from './runtime/gateway-capability-catalog.js'
import { ConversationRunQueue } from './runtime/run-queue.service.js'
import { ConversationRunQueueDispatcher } from './runtime/run-queue.dispatcher.js'
import { SKILL_LIBRARY_DIR, SkillLoader, SkillMaterializer } from './core/skills/index.js'
import { SkillSeedService } from './core/skills/skill-seed.service.js'
import { SkillLibraryService } from './skills/skill.service.js'
import { SkillRepository } from './skills/skill.repository.js'
import { SkillTools } from './skills/skill.tools.js'
import { SkillChangeSubscriber } from './skills/skill-change.subscriber.js'
import {
  MemoryExtractorService,
  MemoryRepository,
  MemoryService,
  MemoryThreadCleanupService,
} from './memory/index.js'
import { toMastraSkills } from './mastra/skill.adapter.js'
import { toMastraTools } from './mastra/tool.adapter.js'
import { AGENT_TOOL_GROUPS, ALL_TOOLS } from './core/tools/tools.types.js'
import { createCapabilityTool } from './core/tools/external.tool.js'
import type { RemoteToolInvoker } from './core/tools/tool.ports.js'
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
import { REMOTE_TOOL_INVOKER, TOOL_CLOCK, TOOL_RATE_COUNTER } from './core/tools/tool.ports.js'
import { RedisToolRateCounter } from './core/tools/tool.rate-counter.redis.js'
import { systemToolClock } from './core/tools/tool.clock.js'
import { ToolCallMetaStore } from './core/tools/tool.meta.js'
import { ToolDiscoveryStore } from './core/tools/tool-discovery.store.js'
import { TaskTool } from './tools/task.tool.js'
import { FileRepository } from './files/file.repository.js'
import { FileService } from './files/file.service.js'
import { FILE_CAPS } from '@repo/ai-data'
import {
  AuditEndPlugin,
  AuditStartPlugin,
  EnabledPlugin,
  PrecheckPlugin,
  RateLimitPlugin,
  RedactPlugin,
  ScopePlugin,
  ValidatePlugin,
} from './core/tools/plugins/index.js'

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
  imports: [],
  controllers: [AgentInternalController],
  providers: [
    SkillSeedService,
    {
      provide: AgentConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AgentConfigValue =>
        config.getOrThrow<AgentConfigValue>('agent'),
    },
    // 提示词引擎：装配期（渲染 agent 定义）与运行期（渲染开局环境片段）共用同一个实例
    { provide: PROMPT_ENGINE, useValue: prompts },
    // 模型网关目录（进程内只读缓存）；同时作为运行时的模型解析端口
    ModelGatewayCatalogService,
    { provide: RUNTIME_MODEL_RESOLVER, useExisting: ModelGatewayCatalogService },

    // ───────────────────────── 工具引擎（主体） ─────────────────────────
    // 工具组实例（**唯一的工具来源**）：注册机对每个组跑 `buildToolSpecs()` 拿 1..n 个工具
    {
      provide: AGENT_TOOL_GROUPS,
      inject: [PlannerTools, RunSubAgentTool, TaskTool, SkillTools],
      // 任务工具（wait-task / cancel-task）只在网关模式下有意义：没配网关就没有 worker 任务，
      // 装配期直接摘掉，避免模型看见两个永远报错的工具。
      useFactory: (...groups: AgentToolGroup[]): AgentToolGroup[] => {
        const hasGateway = Boolean(process.env.TOOL_GATEWAY_URL?.trim())
        return hasGateway ? groups : groups.filter((group) => !(group instanceof TaskTool))
      },
    },
    // 部署上限（env）：库里的值再大也突破不了
    {
      provide: TOOL_ENV_CAPS,
      inject: [AgentConfig],
      useFactory: (config: AgentConfigValue): ToolEnvCaps => ({
        pageBytesMax: config.toolPageBytesMax,
        maxPagesPerTurnMax: config.toolMaxPagesPerTurnMax,
        ...(config.commandWorkDir ? { command: { workDir: config.commandWorkDir } } : {}),
        file: {
          maxBytesMax: config.fileMaxBytes,
          maxFilesMax: config.fileMaxFiles,
          maxTotalBytesMax: config.fileMaxTotalBytes,
          readMaxBytesMax: config.fileReadMaxBytes,
          pageLinesMax: config.filePageLinesMax,
          pageCharsMax: config.filePageCharsMax,
          writeBytesMax: config.fileWriteMaxBytes,
          searchFilesMax: config.fileSearchMaxFiles,
          searchBytesMax: config.fileSearchMaxBytes,
          searchResultsMax: config.fileSearchMaxResults,
          workspaceFilesMax: config.fileWorkspaceMaxFiles,
          workspaceDepthMax: config.fileWorkspaceMaxDepth,
        },
      }),
    },
    { provide: TOOL_CLOCK, useValue: systemToolClock },
    ToolCallMetaStore,
    ToolConfigRepository,
    { provide: TOOL_CONFIG_SOURCE, useExisting: ToolConfigRepository },
    { provide: TIMELINE_REPOSITORY, useExisting: TimelineRepository },
    {
      provide: TOOL_RATE_COUNTER,
      inject: [RedisStore],
      useFactory: (redis: RedisStore) => new RedisToolRateCounter(redis),
    },
    ToolConfigService,
    ToolDiscoveryStore,
    // 网关插件链：**数组顺序 = 执行顺序**（redact → paginate → audit-end 不能换）
    {
      provide: AGENT_TOOL_PLUGINS,
      inject: [TOOL_RATE_COUNTER, AppLogger, ToolCallMetaStore],
      useFactory: (counter: RedisToolRateCounter, logger: AppLogger, metas: ToolCallMetaStore) => [
        new EnabledPlugin(),
        new ScopePlugin(),
        new RateLimitPlugin(counter, logger),
        new ValidatePlugin(),
        new PrecheckPlugin(),
        new AuditStartPlugin(),
        new RedactPlugin(logger),
        new AuditEndPlugin(metas, logger),
      ],
    },
    { provide: REMOTE_TOOL_INVOKER, useFactory: () => createRemoteToolInvoker() },
    ToolGateway,
    ToolRegistry,
    GatewayToolCatalog,
    ToolSeedService,

    // ───────────────────────── 工具组（运行时能力） ─────────────────────────
    AgentRunner,
    SubAgentResultWriter,
    PlannerStore,
    PlannerTools,
    RunSubAgentTool,
    TaskTool,
    SkillTools,
    {
      provide: FILE_CAPS,
      useExisting: TOOL_ENV_CAPS,
    },
    FileRepository,
    FileService,

    // ───────────────────────── 长期记忆（用户级事实）─────────────────────────
    MemoryRepository,
    MemoryService,
    MemoryExtractorService,
    ConversationRunQueue,
    MemoryThreadCleanupService,

    // ───────────────────────── 技能库（DB 是事实源，落盘给 Mastra）─────────────────────────
    // 宿主技能目录来源已删除（P9）：技能只来自「随包 catalog + 技能库落盘投影」，
    // 不再提供 `SKILL_DIRS`，loader 的额外目录参数只剩测试在用。
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
    SkillChangeSubscriber,
    SkillLoader,

    // ───────────────────────── agent 注册表与 Mastra 实例 ─────────────────────────
    {
      provide: AGENT_REGISTRY,
      // 只做声明 → 定义；技能 `'*'` 原样保留，由 `SkillLoader.resolve('*')` 在运行期现算
      inject: [ToolRegistry],
      useFactory: (registry: ToolRegistry): AgentRegistryValue =>
        createAgentRegistry(createAgentDefinitions(prompts, registry), DEFAULT_AGENT_KEY),
    },
    // 短期记忆：生产落 Redis（重启 / 多副本不丢），缺配置时退回进程内
    {
      provide: AGENT_MEMORY,
      inject: [ConfigService, AppLogger],
      useFactory: (config: ConfigService, logger: AppLogger) => {
        const redis = config.get<{ url?: string }>('redis')
        if (!redis?.url) {
          logger.warn('ai.memory.redis_url_missing', { fallback: 'in-memory' })
          return createInMemoryAgentMemory()
        }
        return createAgentMemory(redis.url)
      },
    },
    {
      provide: MASTRA,
      inject: [
        AgentConfig,
        AGENT_REGISTRY,
        ToolRegistry,
        SkillLoader,
        Db,
        AppLogger,
        AGENT_MEMORY,
        GatewayToolCatalog,
        REMOTE_TOOL_INVOKER,
        ToolDiscoveryStore,
      ],
      useFactory: async (
        config: AgentConfigValue,
        registry: AgentRegistryValue,
        tools: ToolRegistry,
        skillLoader: SkillLoader,
        db: Db,
        logger: AppLogger,
        memory: ReturnType<typeof createAgentMemory>,
        catalog: GatewayToolCatalog,
        remote: RemoteToolInvoker | null,
        discovery: ToolDiscoveryStore,
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
          // 授权清单在这里展开（具体 key / `'*'` / `{ category }`）：
          // 工具面按这一次的授权与调用身份过滤 —— 没授权的工具不出现
          resolveTools: async (ids, caller) => {
            const wantsAll = ids.includes(ALL_TOOLS)
            const localKeys = tools.expand(ids)
            // 没有运行时身份（构造期 / 装配期）：只放行 scope='all'，且不碰能力目录
            const local = caller
              ? await tools.authorized(localKeys, caller)
              : await tools.publicKeys(localKeys)
            const toolbox = new Map(tools.toolbox(local))

            if (caller) {
              const capabilities = await catalog.capabilities(caller)
              const visible = new Map(
                (capabilities ?? []).map((capability) => [capability.key, capability]),
              )
              /**
               * 内部服务 + 网关内建（`source='code'`）：随工具面一起给，提示词里也列。
               * 本地注册机已声明的（规划 / 子助手 / 技能 / 网关任务工具）跳过，避免两份。
               */
              for (const [key, capability] of visible) {
                if (capability.source !== 'code') continue
                if (localKeys.includes(key)) continue
                if (!wantsAll && !ids.includes(key)) continue
                toolbox.set(key, createCapabilityTool(capability, remote))
              }
              /**
               * 外部服务（MCP / 手工登记）：**不随工具面下发**；
               * 只补这个会话已经用 `tool-search` 搜到过的（下一轮生效）。
               */
              const discovered = await discovery.list(caller.conversationId)
              for (const key of discovered) {
                const capability = visible.get(key)
                if (!capability || capability.source === 'code') continue
                if (localKeys.includes(key)) continue
                if (!wantsAll && !ids.includes(key)) continue
                toolbox.set(key, createCapabilityTool(capability, remote))
              }
            }

            return toMastraTools(toolbox, logger)
          },
          resolveSkills: async (names) => toMastraSkills(await skillLoader.resolve(names)),
          storage: new AgentMastraStore(db, logger),
          // 短期记忆：生产注入 Redis 实现（缺配置时 provider 已退回进程内）
          memory,
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
    RunStatusStream,
    // 仓储只依赖接口（测试可传替身），实现复用同一份单例
    { provide: RUN_STATUS_LISTENER, useExisting: RunStatusStream },
    TimelineRepository,
    AgentService,
    SkillLibraryService,
    SkillChangeSubscriber,
    AgentConversationService,
    AgentTimelineService,
    AgentRunService,
    ContextService,
    ChatAttachmentService,
    AttachmentKeyPolicy,
    AgentChatService,
    ConversationRunQueueDispatcher,
    AgentTitleService,
    AgentStreamStore,
    AgentRecoveryService,
  ],
  exports: [
    AgentService,
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
