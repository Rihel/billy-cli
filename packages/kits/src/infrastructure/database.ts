import { createDb } from '../db/db.js'
import type {
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  Repository,
} from 'typeorm'
import type { DataSource, DataSourceOptions } from 'typeorm'
import type { AppLogger } from '@repo/shared/logger'
import { Inject, Injectable, type OnAppStart, type OnAppStop } from '@repo/di'
import { DbConfig } from '../foundation/config/db-config.js'
import { Logger } from '../foundation/logger.js'
import { coalesceAsync } from 'promise-coalesce'
export type { DataSource } from 'typeorm'

@Injectable()
export class Db implements OnAppStart, OnAppStop {
  readonly dataSource: DataSource

  @Logger()
  private readonly logger!: AppLogger

  constructor(@Inject(DbConfig) private config: DbConfig) {
    this.dataSource = createDb({
      url: config.url,
      type: 'postgres',
      synchronize: config.sync,
      logging: false,
      poolSize: 10,
      entities: config.entities as DataSourceOptions['entities'],
    })
  }

  private async connect() {
    await coalesceAsync('connect-db', async () => {
      try {
        this.logger.info('正在链接到数据库...', this.config)
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
