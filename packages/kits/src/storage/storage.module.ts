import { Module, type DynamicModule } from '@nestjs/common'
import { CosProvider } from './cos.provider.js'
import { S3Provider } from './s3.provider.js'
import { StorageConfig } from './storage.config.js'
import { StorageService } from './storage.service.js'
import {
  STORAGE_MODULE_OPTIONS,
  type StorageModuleAsyncOptions,
  type StorageModuleOptions,
} from './types.js'

const storageProviders = [
  StorageConfig,
  S3Provider,
  CosProvider,
  StorageService,
]

@Module({})
export class StorageModule {
  static forRoot(options: StorageModuleOptions): DynamicModule {
    return {
      module: StorageModule,
      providers: [
        { provide: STORAGE_MODULE_OPTIONS, useValue: options },
        ...storageProviders,
      ],
      exports: [STORAGE_MODULE_OPTIONS, ...storageProviders],
    }
  }

  static forRootAsync(options: StorageModuleAsyncOptions): DynamicModule {
    return {
      module: StorageModule,
      imports: options.imports,
      providers: [
        {
          provide: STORAGE_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        ...storageProviders,
      ],
      exports: [STORAGE_MODULE_OPTIONS, ...storageProviders],
    }
  }
}
