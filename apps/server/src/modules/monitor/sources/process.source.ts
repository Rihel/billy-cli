import { Injectable } from '@nestjs/common'
import type { MetricSource } from '../definitions/metric.types.js'

export interface ProcessMemory {
  used: number
  total: number
}

/** 进程内存源：当前值，不依赖窗口 */
@Injectable()
export class ProcessSource implements MetricSource<ProcessMemory> {
  readonly key = 'process'

  async read(): Promise<ProcessMemory> {
    const memory = process.memoryUsage()
    return { used: memory.heapUsed, total: memory.heapTotal }
  }
}
