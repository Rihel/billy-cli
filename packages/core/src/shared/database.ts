import { createDb } from '@repo/db'
import type {
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  Repository,
} from 'typeorm'
import type { DataSource } from 'typeorm'
import type { AppLogger } from '@repo/shared/logger'
import { inject, injectable } from 'inversify'
import type { OnAppStart, OnAppStop } from '../life-cycle.js'
import { AppConfig } from './app-config.js'
import { Logger } from './logger.decorator.js'

export type { DataSource } from 'typeorm'

/**
 * TypeORM 数据库门面。
 *
 * - `ready`：幂等初始化 DataSource（首次访问时建立连接）
 * - `getRepository` / `transaction`：仓储与事务入口
 * - `close`：释放连接池
 */
@injectable()
export class Db implements OnAppStart, OnAppStop {
  readonly dataSource: DataSource

  @Logger()
  private readonly logger!: AppLogger

  private initPromise: Promise<void> | null = null

  constructor(@inject(AppConfig) config: AppConfig) {
    this.logger.info('正在链接到数据库...', { url: config.db.url })
    this.dataSource = createDb({
      url: config.db.url,
      type: 'postgres',
    })
  }

  /** 确保 DataSource 已初始化（幂等），连接失败时抛出。 */
  get ready(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.dataSource
        .initialize()
        .then(() => this.logger.info('数据库连接已就绪'))
        .catch((cause: unknown) => {
          this.logger.error('数据库连接失败', { cause })
          throw cause
        })
    }
    return this.initPromise
  }

  getRepository<T extends ObjectLiteral>(
    target: EntityTarget<T>,
  ): Repository<T> {
    return this.dataSource.getRepository(target)
  }

  /** 在数据库事务中运行回调；回调抛出的错误触发回滚并原样传播。 */
  async transaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    await this.ready
    return this.dataSource.transaction(fn)
  }

  /** 应用启动：初始化 DataSource 连接。 */
  async onAppStart(): Promise<void> {
    await this.ready
  }

  /** 应用停止：释放连接池。 */
  async onAppStop(): Promise<void> {
    await this.close()
  }

  async close(): Promise<void> {
    if (this.dataSource.isInitialized) {
      this.logger.info('正在关闭数据库连接')
      await this.dataSource.destroy()
      this.logger.info('数据库连接已关闭')
    }
  }
}
