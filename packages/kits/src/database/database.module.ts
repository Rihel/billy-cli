import { DynamicModule, Global, Module } from '@nestjs/common'
import {
  DATABASE_MODULE_OPTIONS,
  type DatabaseModuleOptions,
} from './database.options.js'
import { DbService } from './database.service.js'

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: DATABASE_MODULE_OPTIONS, useValue: options },
        DbService,
      ],
      exports: [DATABASE_MODULE_OPTIONS, DbService],
    }
  }
}
