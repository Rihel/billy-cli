import type { AppLogger } from '@repo/shared/logger'
import {
  Queue,
  Worker,
  type Job,
  type JobsOptions,
  type WorkerOptions,
} from 'bullmq'
import { Inject, Injectable, type OnAppStart, type OnAppStop } from '@repo/di'
import { RedisConfig } from '../foundation/config/redis-config.js'
import { QueueError } from '../foundation/errors/infrastructure-errors.js'
import { Logger } from '../foundation/logger.js'

/** 业务侧队列任务处理器：接收一个 Job，返回 Promise。 */
export type QueueHandler<T = unknown> = (job: Job<T>) => Promise<void>

interface WorkerRegistration {
  handler: QueueHandler
  options?: WorkerOptions
}

/**
 * 队列基础设施门面（BullMQ）。
 *
 * - 生产者：`addJob(queueName, name, data, opts)` 或按需取队列 `getQueue`（raw 兜底）。
 * - 消费者：业务模块构造期 `registerWorker(queueName, handler)`，Worker 在应用启动时统一拉起。
 * - 每个 Queue / Worker 独占一条 ioredis 连接，从 `config.url` 构造；
 *   连接由 BullMQ 管理，`onAppStop` 时统一关闭。
 */
@Injectable()
export class QueueManager implements OnAppStart, OnAppStop {
  @Logger()
  private readonly logger!: AppLogger

  private readonly queues = new Map<string, Queue>()
  private readonly workers = new Map<string, Worker>()
  private readonly registrations = new Map<string, WorkerRegistration>()

  private readonly connectionUrl: string
  private readonly prefix: string

  constructor(@Inject(RedisConfig) config: RedisConfig) {
    this.connectionUrl = config.url
    this.prefix = config.keyPrefix ?? 'bull'
  }

  /** 按需创建（幂等）并返回指定队列的底层 Queue，供未封装的高级用法兜底。 */
  getQueue<T>(name: string): Queue<T> {
    let queue = this.queues.get(name)
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection(),
        prefix: this.prefix,
      })
      this.queues.set(name, queue)
    }
    return queue as unknown as Queue<T>
  }

  /** 生产者：向指定队列投递一个任务。 */
  addJob<T>(queueName: string, name: string, data: T, options?: JobsOptions): Promise<Job<T>> {
    const queue = this.getQueue<any>(queueName)
    return this.guard(() => queue.add(name, data, options)) as Promise<Job<T>>
  }

  /**
   * 消费者注册：业务模块在构造期注册处理器，Worker 在应用启动时统一拉起。
   * 同一队列只允许注册一个 Worker，重复注册抛 {@link QueueError}。
   */
  registerWorker<T>(queueName: string, handler: QueueHandler<T>, options?: WorkerOptions): void {
    if (this.registrations.has(queueName)) {
      throw new QueueError(new Error(`队列已注册消费者: ${queueName}`))
    }
    this.registrations.set(queueName, {
      handler: handler as QueueHandler,
      options,
    })
    this.logger.info('已注册队列消费者', { queueName })
  }

  /** 应用启动：拉起全部已注册的 Worker。 */
  async onAppStart(): Promise<void> {
    for (const [name, registration] of this.registrations) {
      this.workers.set(name, this.createWorker(name, registration))
    }
  }

  /** 应用停止：先关闭 Worker，再关闭 Queue。 */
  async onAppStop(): Promise<void> {
    await Promise.all([...this.workers.values()].map((worker) => worker.close()))
    this.workers.clear()
    await Promise.all([...this.queues.values()].map((queue) => queue.close()))
    this.queues.clear()
  }

  private createWorker(name: string, registration: WorkerRegistration): Worker {
    const { handler, options } = registration
    const worker = new Worker(
      name,
      async (job) => {
        try {
          await handler(job)
        } catch (error) {
          this.logger.error('队列任务处理异常，将交由队列重试', {
            queueName: name,
            jobId: job.id,
            error,
          })
          throw error
        }
      },
      {
        concurrency: 1,
        ...options,
        connection: this.connection(),
        prefix: this.prefix,
      },
    )
    worker.on('failed', (job, error) => {
      this.logger.error('队列任务最终失败', { queueName: name, jobId: job?.id, error })
    })
    return worker
  }

  private connection(): { url: string; maxRetriesPerRequest: null } {
    return { url: this.connectionUrl, maxRetriesPerRequest: null }
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (cause) {
      throw new QueueError(cause)
    }
  }
}
