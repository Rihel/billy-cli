import { Inject, Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AiProviderKind, AiModelSource } from '@repo/shared'
import { AppLogger } from '@repo/kits'
import { AdminModule } from '../admin/admin.module.js'
import { AiModelController } from './ai-model.controller.js'
import { AiModelRepository, AiProviderRepository } from './ai-model.repository.js'
import { AI_MODEL_CONFIG, AiModelService, type AiModelConfig } from './ai-model.service.js'
import { encryptSecret, hintOf, resolveEncryptionSecret } from './model-secret.js'

/** 环境变量种子初始化时创建的供应商展示名（固定值，便于人辨认"这是自动建的"） */
const SEED_PROVIDER_NAME = '环境变量默认'
/** 环境变量种子初始化时创建的供应商 slug */
const SEED_PROVIDER_SLUG = 'env-default'

/**
 * 从 `MASTRA_MODEL` 的前缀推导供应商类型（`deepseek/deepseek-flash` → `deepseek`）。
 *
 * 为什么必须推导而不是一律写 `openai-compatible`（踩过）：`kind` 是运行时判断
 * "走官方 SDK 还是通用兼容"的**唯一依据**（见 `usesOfficialAdapter`）。种子若把 DeepSeek
 * 写成通用兼容，就会出现"前台配着 DeepSeek 却拿不到思考"——通用兼容层不认
 * `reasoning_content`，整段思考被丢掉，而且 `agent.stream()` 的返回形态也跟着变。
 *
 * 认不出的前缀（自建网关 / 别的模型名）才回落 `openai-compatible`（那也是它的语义：
 * 协议形态兜底，不是某一家厂商）。
 */
const providerKindFromModelRef = (modelRef: string): string => {
  const prefix = modelRef.includes('/') ? modelRef.slice(0, modelRef.indexOf('/')) : ''
  return (AiProviderKind.values as string[]).includes(prefix)
    ? prefix
    : AiProviderKind.OpenaiCompatible
}

/**
 * **环境变量种子服务**：把历史上只能用 `MASTRA_MODEL` / `MASTRA_API_KEY` / `MASTRA_BASE_URL`
 * 配置的模型，在**首次启动**时搬进库里（设计文档 §4.9：环境变量从此只是可选种子，不是运行时来源）。
 *
 * 触发条件（全部满足才做，否则**什么都不做**）：
 * 1. `AGENT_SEED_FROM_ENV`（`aiModel.seedFromEnv`）为真；
 * 2. **库里一条供应商都没有**（连软删的历史行都没有 —— 否则人主动删光后重启会把它们种回来）；
 * 3. `MASTRA_MODEL` 与 `MASTRA_API_KEY` 都非空。
 *
 * 种子模型的 `modelKey` 取 `MASTRA_MODEL` 里 `/` **之后**的部分（`deepseek/deepseek-chat`
 * → `deepseek-chat`），没有 `/` 就用整串；`source='manual'`（人配的，同步不覆盖）。
 */
@Injectable()
export class AiModelSeedService implements OnApplicationBootstrap {
  constructor(
    @Inject(AI_MODEL_CONFIG) private readonly config: AiModelConfig,
    @Inject(AiProviderRepository) private readonly providers: AiProviderRepository,
    @Inject(AiModelRepository) private readonly models: AiModelRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.seedFromEnv) return

    const envModel = process.env.MASTRA_MODEL?.trim()
    const envApiKey = process.env.MASTRA_API_KEY?.trim()
    if (!envModel || !envApiKey) return

    try {
      const seedKind = providerKindFromModelRef(envModel)

      // ① 还没种过：库里一条供应商都没有 → 建种子供应商 + 种子模型
      if ((await this.providers.countIncludingDeleted()) === 0) {
        const secret = resolveEncryptionSecret({
          encryptionKey: this.config.encryptionKey,
          fallbackSecret: this.config.fallbackSecret,
        })
        const baseUrl = process.env.MASTRA_BASE_URL?.trim() || null
        const modelKey = envModel.includes('/')
          ? envModel.slice(envModel.lastIndexOf('/') + 1)
          : envModel

        const provider = await this.providers.create({
          name: SEED_PROVIDER_NAME,
          slug: SEED_PROVIDER_SLUG,
          kind: seedKind,
          baseUrl,
          apiKeyCipher: encryptSecret(envApiKey, secret),
          apiKeyHint: hintOf(envApiKey),
          enabled: true,
        })
        await this.models.create({
          providerId: provider.id,
          modelKey,
          displayName: modelKey,
          source: AiModelSource.Manual,
          enabled: true,
          lastSeenAt: null,
          syncedAt: null,
          raw: null,
        })

        this.logger.log(
          '已用环境变量种子初始化，后续请在后台模型管理维护（环境变量不再决定运行时模型）',
          {
            providerId: provider.id,
            slug: provider.slug,
            kind: provider.kind,
            modelKey,
            hasBaseUrl: Boolean(baseUrl),
          },
        )
        return
      }

      // ② 种子供应商的类型自愈：早期版本把种子一律写成 `openai-compatible`，
      //    于是"官方适配"失效（思考字段整段丢失、流返回形态变成包装对象）。
      //    **只修种子供应商**（slug 固定、名固定），人自己建的供应商一律不动。
      await this.repairSeedProviderKind(seedKind)
    } catch (error) {
      // 种子失败不能拖垮启动：AI 能力不可用是可接受的状态（页面会提示去后台配模型）
      this.logger.error('环境变量种子初始化失败（已跳过，不影响启动）', { error })
    }
  }

  /**
   * 把种子供应商的 `kind` 修正为从 `MASTRA_MODEL` 推导出来的值（已是正确值则不动）。
   *
   * 判据刻意收紧：**slug 与名都等于种子固定值**才修 —— 人可能把种子那家改成别的，
   * 那时它就不再是"种子"，不能替人做决定。
   */
  private async repairSeedProviderKind(seedKind: string): Promise<void> {
    const seed = await this.providers.findBySlug(SEED_PROVIDER_SLUG)
    if (!seed || seed.name !== SEED_PROVIDER_NAME || seed.kind === seedKind) return
    await this.providers.update(seed.id, { kind: seedKind })
    this.logger.warn('种子供应商类型已修正（否则官方适配不生效、思考字段会丢）', {
      providerId: seed.id,
      from: seed.kind,
      to: seedKind,
    })
  }
}

/**
 * AI 模型模块：供应商 / 模型的配置与明细同步（`/ai-model/*`）+ 运行时模型解析（供 `AiModule` 用）。
 *
 * `AI_MODEL_CONFIG` 是**本模块自己的配置 bean**（配置即模块自身注入的 bean，惰性取 `ConfigService`）：
 * - `encryptionKey` 取 `aiModel.encryptionKey`（env `AI_MODEL_ENCRYPTION_KEY`，可选）；
 * - `fallbackSecret` 取 `jwt.secret`（两者都缺 → 服务层抛 3405，不静默存明文）；
 * - `seedFromEnv` 取 `aiModel.seedFromEnv`（env `AGENT_SEED_FROM_ENV`，默认 true）。
 *
 * **exports `AiModelService`**：`AiModule` 的运行时靠它解析"这一轮用哪个模型"。
 */
@Module({
  imports: [AdminModule],
  controllers: [AiModelController],
  providers: [
    AiProviderRepository,
    AiModelRepository,
    {
      provide: AI_MODEL_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AiModelConfig => ({
        encryptionKey: config.get<string>('aiModel.encryptionKey'),
        fallbackSecret: config.get<string>('jwt.secret'),
        seedFromEnv: config.get<boolean>('aiModel.seedFromEnv') ?? true,
      }),
    },
    AiModelService,
    AiModelSeedService,
  ],
  exports: [AiModelService],
})
export class AiModelModule {}
