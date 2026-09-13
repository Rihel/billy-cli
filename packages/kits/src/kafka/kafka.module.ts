import { Global, Module, type DynamicModule } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import type { z } from 'zod'
import type { InfraModuleAsyncOptions } from '../foundation/infra-module.js'
import {
  KafkaConfig,
  KafkaConfigSchema,
  type KafkaConfig as KafkaConfigType,
} from './kafka.config.js'
import { KafkaConsumerScanner } from './kafka-consumer-scanner.js'
import { KafkaService, createKafkaConnection } from './kafka.service.js'
import { KAFKA_CONNECTION } from './kafka.providers.js'

/** KafkaModule.forRoot 入参 = KafkaConfigSchema 的输入类型 */
export type KafkaModuleOptions = z.input<typeof KafkaConfigSchema>

/**
 * Kafka 模块：`forRoot(options)` 显式传入 broker 与命名前缀，配置对象本身即注入 bean（KafkaConfig）。
 * 导入 DiscoveryModule 以支持 `@KafkaConsumer` 扫描；未导入本模块则无 Kafka provider（用了即解析报错）。
 */
@Global()
@Module({})
export class KafkaModule {
  static forRoot(options: KafkaModuleOptions): DynamicModule {
    const config = KafkaConfigSchema.parse(options)
    return {
      module: KafkaModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: KafkaConfig, useValue: config },
        { provide: KAFKA_CONNECTION, useFactory: () => createKafkaConnection(config) },
        KafkaService,
        KafkaConsumerScanner,
      ],
      exports: [KafkaConfig, KAFKA_CONNECTION, KafkaService],
    }
  }

  /** 异步装配：配置由注入的 provider（如 ConfigService）惰性解析 */
  static forRootAsync(
    options: InfraModuleAsyncOptions<KafkaModuleOptions>,
  ): DynamicModule {
    return {
      module: KafkaModule,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers: [
        { provide: KafkaConfig, useFactory: options.useFactory, inject: options.inject ?? [] },
        {
          provide: KAFKA_CONNECTION,
          inject: [KafkaConfig],
          useFactory: (config: KafkaConfigType) => createKafkaConnection(config),
        },
        KafkaService,
        KafkaConsumerScanner,
      ],
      exports: [KafkaConfig, KAFKA_CONNECTION, KafkaService],
    }
  }

}
