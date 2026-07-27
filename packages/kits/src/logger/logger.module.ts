import { DynamicModule, Global, Module } from '@nestjs/common'
import {
  LOGGER_MODULE_OPTIONS,
  type LoggerModuleOptions,
} from './logger.options.js'
import { AppLoggerService } from './logger.service.js'

@Global()
@Module({})
export class LoggerModule {
  static forRoot(options: LoggerModuleOptions = {}): DynamicModule {
    return {
      module: LoggerModule,
      providers: [
        { provide: LOGGER_MODULE_OPTIONS, useValue: options },
        AppLoggerService,
      ],
      exports: [LOGGER_MODULE_OPTIONS, AppLoggerService],
    }
  }
}
