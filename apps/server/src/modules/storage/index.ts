import { Module, type DynamicModule } from '@nestjs/common';
import type {
  StorageModuleAsyncOptions,
  StorageModuleOptions,
} from '@repo/kits';
import { StorageModule as KitsStorageModule } from '@repo/kits';
import { StorageRouter } from './storage.router.js';

@Module({})
export class StorageModule {
  static forRoot(options: StorageModuleOptions): DynamicModule {
    return {
      module: StorageModule,
      imports: [KitsStorageModule.forRoot(options)],
      providers: [StorageRouter],
    };
  }

  static forRootAsync(options: StorageModuleAsyncOptions): DynamicModule {
    return {
      module: StorageModule,
      imports: [KitsStorageModule.forRootAsync(options)],
      providers: [StorageRouter],
    };
  }
}
