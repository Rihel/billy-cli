import { Inject, Injectable, Optional } from '@nestjs/common'
import type {
  AiProviderKeyCreateDto,
  AiProviderKeyIdDto,
  AiProviderKeyListDto,
  AiProviderKeyModel,
  AiProviderKeyUpdateDto,
} from '@repo/shared'
import { AppLogger, EventBus } from '@repo/kits'
import type { AiProviderKeyEntity } from '@repo/db'
import { AI_MODEL_CHANGED_TOPIC } from '@repo/shared'
import { AiProviderKeyRepository } from './ai-provider-key.repository.js'
import { AiProviderRepository } from './ai-model.repository.js'
import { ProviderNotFoundError } from './errors.js'

/** 供应商 key 池（配置面）：列表只回 hasSecret，明文只进不出 */
@Injectable()
export class AiProviderKeyService {
  constructor(
    @Inject(AiProviderKeyRepository) private readonly keys: AiProviderKeyRepository,
    @Inject(AiProviderRepository) private readonly providers: AiProviderRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Optional() @Inject(EventBus) private readonly events?: EventBus,
  ) {}

  private notifyChanged(): void {
    void this.events?.publish(AI_MODEL_CHANGED_TOPIC, { at: Date.now() })
  }

  async list(input: AiProviderKeyListDto): Promise<AiProviderKeyModel[]> {
    return (await this.keys.list(input.providerId)).map(toModel)
  }

  async create(input: AiProviderKeyCreateDto): Promise<AiProviderKeyModel> {
    if (!(await this.providers.findById(input.providerId))) {
      throw new ProviderNotFoundError(input.providerId)
    }
    const record = await this.keys.create({
      providerId: input.providerId,
      label: input.label,
      secret: input.secret.trim(),
      status: input.status ?? 'active',
      weight: input.weight ?? 1,
      rpm: input.rpm ?? null,
      tpm: input.tpm ?? null,
      dailyTokens: input.dailyTokens ?? null,
      dailyCostMicros: input.dailyCostMicros ?? null,
    })
    this.logger.log('ai-model.provider-key.created', {
      keyId: record.id,
      providerId: record.providerId,
    })
    this.notifyChanged()
    return toModel(record)
  }

  async update(input: AiProviderKeyUpdateDto): Promise<AiProviderKeyModel> {
    const existing = await this.keys.findById(input.keyId)
    if (!existing) throw new ProviderNotFoundError(input.keyId)
    const record = await this.keys.update(existing.id, {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.secret !== undefined ? { secret: input.secret.trim() } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.weight !== undefined ? { weight: input.weight } : {}),
      ...(input.rpm !== undefined ? { rpm: input.rpm } : {}),
      ...(input.tpm !== undefined ? { tpm: input.tpm } : {}),
      ...(input.dailyTokens !== undefined ? { dailyTokens: input.dailyTokens } : {}),
      ...(input.dailyCostMicros !== undefined ? { dailyCostMicros: input.dailyCostMicros } : {}),
    })
    if (!record) throw new ProviderNotFoundError(input.keyId)
    this.logger.log('ai-model.provider-key.updated', { keyId: record.id })
    this.notifyChanged()
    return toModel(record)
  }

  async remove(input: AiProviderKeyIdDto): Promise<void> {
    await this.keys.softDelete(input.keyId)
    this.logger.log('ai-model.provider-key.removed', { keyId: input.keyId })
    this.notifyChanged()
  }
}

const toModel = (record: AiProviderKeyEntity): AiProviderKeyModel => ({
  id: record.id,
  providerId: record.providerId,
  label: record.label,
  status: record.status === 'disabled' ? 'disabled' : 'active',
  weight: record.weight,
  rpm: record.rpm,
  tpm: record.tpm,
  dailyTokens: record.dailyTokens,
  dailyCostMicros: record.dailyCostMicros,
  hasSecret: Boolean(record.secret),
  failureCount: record.failureCount,
  lastUsedAt: record.lastUsedAt ?? undefined,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
})
