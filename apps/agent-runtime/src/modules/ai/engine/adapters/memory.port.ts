import { Inject, Injectable, Optional } from '@nestjs/common'
import {
  MemoryExtractorService,
  type MemoryExtractionInput,
  type MemoryExtractionResult,
} from '../../domain/memory/memory.extractor.service.js'
import { MemoryService } from '../../domain/memory/memory.service.js'
import type { MemoryBlock, MemoryPort } from '../ports.js'

/**
 * 记忆接缝适配器：包装现有 `MemoryService`（轮前召回）与 `MemoryExtractorService`（轮后抽取）。
 *
 * 两者都可能是缺省的（测试 / 脚本手工构造不传），缺省时召回返回 null、抽取返回 null，
 * 与原先的可选注入语义一致。
 */
@Injectable()
export class MemoryPortAdapter implements MemoryPort {
  constructor(
    @Optional() @Inject(MemoryService) private readonly memory?: MemoryService | null,
    @Optional()
    @Inject(MemoryExtractorService)
    private readonly extractor?: MemoryExtractorService | null,
  ) {}

  recall(userId: string, agentKey: string): Promise<MemoryBlock | null> {
    return this.memory ? this.memory.collect(userId, agentKey) : Promise.resolve(null)
  }

  extract(input: MemoryExtractionInput): Promise<MemoryExtractionResult | null> {
    return this.extractor ? this.extractor.maybeExtract(input) : Promise.resolve(null)
  }
}
