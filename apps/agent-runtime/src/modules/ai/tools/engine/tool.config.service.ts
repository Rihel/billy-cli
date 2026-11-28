import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { TOOL_CONFIG_SOURCE, TOOL_ENV_CAPS } from './tool.config.ports.js'
import type { ToolConfigSource } from './tool.config.ports.js'
import { mergeToolSettings } from './tool.settings.js'
import type { ToolEnvCaps, ToolSettings, ToolSpec } from './tools.types.js'

/** 配置缓存 TTL（毫秒） */
const CACHE_TTL_MS = 5_000

/**
 * 生效配置的读取服务（设计 §5.5）：读行 → 合并 → 进程内缓存。
 *
 * 为什么缓存 5 秒而不是永久：配置要"改完下一次调用生效"，而每次工具调用都查库太贵；
 * 5 秒是"人能感知的即时"与"QPS 下的开销"之间的折中；保存后还会**主动失效**（同进程立即生效）。
 * 多实例下别的实例最多晚 5 秒 —— 这条如实写在设计文档里，不假装强一致。
 */
@Injectable()
export class ToolConfigService {
  private readonly cache = new Map<string, { at: number; value: ToolSettings }>()

  constructor(
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(TOOL_CONFIG_SOURCE) private readonly source: ToolConfigSource,
    @Inject(TOOL_ENV_CAPS) private readonly caps: ToolEnvCaps,
  ) {}

  /** 取某个工具的生效配置（带缓存） */
  async settings<C>(spec: ToolSpec<C>): Promise<ToolSettings<C>> {
    const cached = this.cache.get(spec.key)
    const now = Date.now()
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.value as ToolSettings<C>
    const row = await this.source.load(spec)
    const value = mergeToolSettings(spec, row, this.caps)
    this.cache.set(spec.key, { at: now, value: value as ToolSettings })
    return value
  }

  /** 保存后主动失效（同一进程内立刻生效；别的实例靠 TTL 过期） */
  invalidate(key?: string): void {
    if (key) this.cache.delete(key)
    else this.cache.clear()
    this.logger.debug('ai.tool.config.invalidated', { key: key ?? 'all' })
  }
}
