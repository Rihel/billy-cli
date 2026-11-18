import { Inject, Injectable } from '@nestjs/common'
import { scanCapabilities, type CapabilityDefinition } from '@repo/capability'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { BashExecutor } from './bash.executor.js'
import { WebFetchExecutor } from '../tools/web/web-fetch.executor.js'
import { WebSearchExecutor } from '../tools/web/web-search.executor.js'
import { WebRequestExecutor } from '../tools/web/web-request.executor.js'
import { MemoryExecutor } from '../tools/memory/memory.executor.js'
import { FileExecutor } from '../tools/file/file.executor.js'
import { ReadToolResultExecutor } from '../tools/read-tool-result.executor.js'
import type { ToolExecutor } from './tool.executor.js'

/**
 * worker 的执行器注册表。
 *
 * 新增能力 = 给执行器加一个带 `@CapabilityDecl` 的方法（key 就是工具名），这里不再手工列 key：
 * 注册表从声明扫描绑定（`scanCapabilities`），声明缺执行体在启动期就抛。
 */
@Injectable()
export class ToolExecutorRegistry {
  private readonly executors = new Map<string, ToolExecutor>()
  private readonly declarations = new Map<string, CapabilityDefinition>()
  private readonly executorInstances: readonly object[]

  constructor(
    @Inject(BashExecutor) bash: BashExecutor,
    @Inject(WebFetchExecutor) webFetch: WebFetchExecutor,
    @Inject(WebSearchExecutor) webSearch: WebSearchExecutor,
    @Inject(WebRequestExecutor) webRequest: WebRequestExecutor,
    @Inject(MemoryExecutor) memory: MemoryExecutor,
    @Inject(FileExecutor) file: FileExecutor,
    @Inject(ReadToolResultExecutor) readToolResult: ReadToolResultExecutor,
  ) {
    this.executorInstances = [bash, webFetch, webSearch, webRequest, memory, file, readToolResult]
    for (const instance of this.executorInstances) {
      for (const { method, decl } of scanCapabilities(instance)) {
        const handler = (instance as Record<string, unknown>)[method] as (
          request: ToolInvokeRequest,
        ) => Promise<ToolOutcome>
        this.bind({ key: decl.tool, execute: (request) => handler.call(instance, request) }, decl)
      }
    }
  }

  /** 能力登记用：按声明顺序给出的执行器实例（manifest 从它们聚合能力） */
  instances(): readonly object[] {
    return this.executorInstances
  }

  /** 能力登记用：已绑定的能力声明（与执行体同一份） */
  definitions(): CapabilityDefinition[] {
    return [...this.declarations.values()]
  }

  /** 声明为 `mode:'task'` 的能力（协议 §6：先受理再查/取消） */
  isTaskTool(toolKey: string): boolean {
    return this.declarations.get(toolKey)?.execution?.mode === 'task'
  }

  /** 任务的总寿命（协议 §13 的 `maxRunMs`）：任务执行预算按它算，不按单次 HTTP 的 deadline 算 */
  maxRunMs(toolKey: string): number {
    return this.declarations.get(toolKey)?.execution?.maxRunMs ?? 1_800_000
  }

  get(toolKey: string): ToolExecutor | undefined {
    return this.executors.get(toolKey)
  }

  tools(): string[] {
    return [...this.executors.keys()]
  }

  private bind(executor: ToolExecutor, decl: CapabilityDefinition): void {
    if (this.executors.has(executor.key)) {
      throw new Error(`执行器重复注册：${executor.key}`)
    }
    this.executors.set(executor.key, executor)
    this.declarations.set(executor.key, decl)
  }
}
