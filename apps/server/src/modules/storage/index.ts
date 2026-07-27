import { Module, type DynamicModule } from '@nestjs/common';
import type {
  StorageModuleAsyncOptions,
  StorageModuleOptions,
} from '@repo/kits';
import { StorageModule as KitsStorageModule } from '@repo/kits';
import { StorageController } from './storage.controller.js';

@Module({})
export class StorageModule {
  static forRoot(options: StorageModuleOptions): DynamicModule {
    return {
      module: StorageModule,
      imports: [KitsStorageModule.forRoot(options)],
      controllers: [StorageController],
    };
  }

  static forRootAsync(options: StorageModuleAsyncOptions): DynamicModule {
    return {
      module: StorageModule,
      imports: [KitsStorageModule.forRootAsync(options)],
      controllers: [StorageController],
    };
  }
}
