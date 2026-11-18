import { Inject, Injectable } from '@nestjs/common'
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
 * 新增工具 = 新写一个 `ToolExecutor` provider 并在构造器里注册；
 * 能力登记时按这里的 key 映射到 `服务名/工具名`，避免“说支持、实际没有”的漂移。
 */
@Injectable()
export class ToolExecutorRegistry {
  private readonly executors = new Map<string, ToolExecutor>()

  constructor(
    @Inject(BashExecutor) bash: BashExecutor,
    @Inject(WebFetchExecutor) webFetch: WebFetchExecutor,
    @Inject(WebSearchExecutor) webSearch: WebSearchExecutor,
    @Inject(WebRequestExecutor) webRequest: WebRequestExecutor,
    @Inject(MemoryExecutor) memory: MemoryExecutor,
    @Inject(FileExecutor) file: FileExecutor,
    @Inject(ReadToolResultExecutor) readToolResult: ReadToolResultExecutor,
  ) {
    this.register(bash)
    this.register(webFetch)
    this.register(webSearch)
    this.register(webRequest)
    for (const key of memory.keys) {
      this.register({ key, execute: (request) => memory.execute(key, request) })
    }
    for (const key of file.keys) {
      this.register({ key, execute: (request) => file.execute(key, request) })
    }
    this.register(readToolResult)
  }

  register(executor: ToolExecutor): void {
    if (this.executors.has(executor.key)) {
      throw new Error(`执行器重复注册：${executor.key}`)
    }
    this.executors.set(executor.key, executor)
  }

  get(toolKey: string): ToolExecutor | undefined {
    return this.executors.get(toolKey)
  }

  tools(): string[] {
    return [...this.executors.keys()]
  }
}
