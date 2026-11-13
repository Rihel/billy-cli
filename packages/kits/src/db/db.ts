import { createDb } from './create-db.js'
import { deleteDataSourceByName } from 'typeorm-transactional'
import type { EntityTarget, ObjectLiteral, Repository } from 'typeorm'
import type { DataSource, DataSourceOptions } from 'typeorm'
import { AppLogger } from '../foundation/logger/app-logger.js'
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { DbConfig } from './db.config.js'
import { coalesceAsync } from 'promise-coalesce'
export type { DataSource } from 'typeorm'

@Injectable()
export class Db implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly dataSource: DataSource

  constructor(
    @Inject(DbConfig) private config: DbConfig,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.dataSource = createDb({
      url: config.url,
      synchronize: config.sync,
      logging: false,
      poolSize: 10,
      entities: config.entities as DataSourceOptions['entities'],
      subscribers: config.subscribers as DataSourceOptions['subscribers'],
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

  getRepository<T extends ObjectLiteral>(target: EntityTarget<T>): Repository<T> {
    return this.dataSource.getRepository(target)
  }

  /** 应用启动：初始化 DataSource 连接。 */
  async onApplicationBootstrap(): Promise<void> {
    await this.connect()
  }

  /** 应用停止：释放连接池。 */
  async onApplicationShutdown(): Promise<void> {
    await this.close()
  }

  async close(): Promise<void> {
    await coalesceAsync('disconnected-db', async () => {
      if (this.dataSource.isInitialized) {
        this.logger.info('正在关闭数据库连接')
        await this.dataSource.destroy()
        this.logger.info('数据库连接已关闭')
      }
      // 顺手从 typeorm-transactional 的注册表移除本条：
      // 它按 **名字** 注册（默认 'default'），不移除的话同一进程里再次 `new Db(...)`
      // 会直接抛 "DataSource with name \"default\" has already added"（单测里尤其明显）
      deleteDataSourceByName(this.dataSource.name)
    })
  }
}
