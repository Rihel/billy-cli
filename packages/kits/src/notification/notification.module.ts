import type { InfraModuleAsyncOptions } from '../foundation/infra-module.js'
import { Global, Module, type DynamicModule } from '@nestjs/common'
import type { z } from 'zod'
import {
  NotifyConfig,
  NotifyConfigSchema,
} from './notify.config.js'
import { EmailClient } from './email/email.client.js'
import { FileClient } from './file/file.client.js'
import { LarkNotifyClient } from './lark-notify/lark-notify.client.js'
import { Notifier } from './notifier.js'

/** NotificationModule.forRoot 入参 = NotifyConfigSchema 的输入类型 */
export type NotificationModuleOptions = z.input<typeof NotifyConfigSchema>

/**
 * 通知模块：`forRoot(options)` 显式传入通道配置，配置对象本身即注入 bean（NotifyConfig）。
 *
 * 装配 Notifier（编排门面）+ 文件输出（默认通道）+ 邮件 + 飞书通知；
 * 未导入 LarkModule 时 LarkClient 缺失，LarkNotifyClient 以 `@Optional()` 降级，
 * 对应通道 send 返回「通道未配置」。
 */
@Global()
@Module({})
export class NotificationModule {
  static forRoot(options: NotificationModuleOptions): DynamicModule {
    return {
      module: NotificationModule,
      providers: [
        { provide: NotifyConfig, useValue: NotifyConfigSchema.parse(options) },
        Notifier,
        FileClient,
        EmailClient,
        LarkNotifyClient,
      ],
      exports: [NotifyConfig, Notifier, FileClient, EmailClient, LarkNotifyClient],
    }
  }

  /**
   * 异步装配：配置由注入的 provider（如 ConfigService）惰性解析 ——
   * 避免在模块装饰器求值时读取尚未加载的配置。
   */
  static forRootAsync(
    options: InfraModuleAsyncOptions<NotificationModuleOptions>,
  ): DynamicModule {
    return {
      module: NotificationModule,
      imports: options.imports ?? [],
      providers: [
        { provide: NotifyConfig, useFactory: options.useFactory, inject: options.inject ?? [] },
        Notifier,
        FileClient,
        EmailClient,
        LarkNotifyClient,
      ],
      exports: [NotifyConfig,
        Notifier,
        FileClient,
        EmailClient,
        LarkNotifyClient,],
    }
  }
}
