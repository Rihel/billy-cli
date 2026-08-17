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
import { coalesceAsync } from 'promise-coalesce'
export type { DataSource } from 'typeorm'

@injectable()
export class Db implements OnAppStart, OnAppStop {
  readonly dataSource: DataSource

  @Logger()
  private readonly logger!: AppLogger

  constructor(@inject(AppConfig) private config: AppConfig) {
    this.dataSource = createDb({
      url: config.db.url,
      type: 'postgres',
      synchronize: config.db.sync,
      logging: false,
      poolSize: 10,
    })
  }

  private async connect() {
    await coalesceAsync('connect-db', async () => {
      try {
        this.logger.info('正在链接到数据库...', this.config.db)
        await this.dataSource.initialize()
        this.logger.info('数据库连接已就绪')
      } catch (error) {
        this.logger.error('数据库连接失败', { error })
      }
    })
  }

  getRepository<T extends ObjectLiteral>(
    target: EntityTarget<T>,
  ): Repository<T> {
    return this.dataSource.getRepository(target)
  }

  /** 应用启动：初始化 DataSource 连接。 */
  async onAppStart(): Promise<void> {
    await this.connect()
  }

  /** 应用停止：释放连接池。 */
  async onAppStop(): Promise<void> {
    await this.close()
  }

  async close(): Promise<void> {
    await coalesceAsync('disconnected-db', async () => {
      if (this.dataSource.isInitialized) {
        this.logger.info('正在关闭数据库连接')
        await this.dataSource.destroy()
        this.logger.info('数据库连接已关闭')
      }
    })
  }
}
