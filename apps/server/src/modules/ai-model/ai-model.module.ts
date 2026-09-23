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
      if ((await this.providers.countIncludingDeleted()) > 0) return

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
        kind: AiProviderKind.OpenaiCompatible,
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
        { providerId: provider.id, slug: provider.slug, modelKey, hasBaseUrl: Boolean(baseUrl) },
      )
    } catch (error) {
      // 种子失败不能拖垮启动：AI 能力不可用是可接受的状态（页面会提示去后台配模型）
      this.logger.error('环境变量种子初始化失败（已跳过，不影响启动）', { error })
    }
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
