import { Global, Module } from '@nestjs/common';
import { STORAGE_MODULE_OPTIONS } from './interface.js';
import type {
  StorageModuleAsyncOptions,
  StorageModuleOptions,
} from './interface.js';

import { CosProvider } from './providers/cos.provider.js';
import { S3Provider } from './providers/s3.provider.js';
import { StorageConfig } from './storage.config.js';
import { StorageService } from './storage.service.js';
import { StorageRouter } from './storage.router.js';

const providers = [
  StorageConfig,
  S3Provider,
  StorageService,
  CosProvider,
  StorageRouter,
];

@Module({})
export class StorageModule {
  static forRoot(options: StorageModuleOptions) {
    const optionsProvider = {
      provide: STORAGE_MODULE_OPTIONS,
      useValue: options,
    };
    return {
      module: StorageModule,
      providers: [optionsProvider, ...providers],
      exports: [optionsProvider, ...providers],
    };
  }

  static forRootAsync(options: StorageModuleAsyncOptions) {
    const optionsProvider = {
      provide: STORAGE_MODULE_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject || [],
    };
    return {
      module: StorageModule,

      imports: options.imports || [],
      providers: [optionsProvider, ...providers],
      exports: [optionsProvider, ...providers],
    };
  }
}
