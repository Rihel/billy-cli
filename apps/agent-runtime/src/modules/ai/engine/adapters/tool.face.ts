import { Inject, Injectable } from '@nestjs/common'
import { ToolRegistry } from '../../tools/engine/tool.registry.js'
import type { Toolbox, ToolCallerIdentity, ToolSpec } from '../../tools/engine/tools.types.js'
import type { ToolFace } from '../ports.js'

/**
 * 工具面适配器：转发到注册机（`ToolRegistry`）。
 *
 * 引擎只需要「按授权取工具表」这一件事；越权过滤、`'*'` / `{ category }` 展开、
 * 工具配置合并都已在注册机里，这里不重新实现。
 */
@Injectable()
export class ToolFaceAdapter implements ToolFace {
  constructor(@Inject(ToolRegistry) private readonly registry: ToolRegistry) {}

  expand(selectors: readonly string[]): string[] {
    return this.registry.expand(selectors)
  }

  authorized(keys: readonly string[], caller: ToolCallerIdentity): Promise<string[]> {
    return this.registry.authorized(keys, caller)
  }

  toolbox(keys: readonly string[]): Toolbox {
    return this.registry.toolbox(keys)
  }

  spec(key: string): ToolSpec {
    return this.registry.spec(key)
  }

  has(key: string): boolean {
    return this.registry.get(key) !== undefined
  }
}
