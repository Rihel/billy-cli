import { Inject, Injectable } from '@nestjs/common'
import { AppLoggerService } from '../logger/logger.service.js'
import { als } from './request-context.store.js'

@Injectable()
export class RequestContextService<T extends Record<string, any> = Record<string, any>> {
  constructor(
    @Inject(AppLoggerService) private readonly logger: AppLoggerService,
  ) {
    this.logger.setContext(RequestContextService.name)
  }

  run(store: T, callback: () => void) {
    als.run(store, callback)
  }

  getStore(): T | undefined {
    return als.getStore() as T | undefined
  }

  get<K extends keyof T>(key: K): T[K] | undefined {
    const store = this.getStore()
    return store ? store[key] : undefined
  }

  set<K extends keyof T>(key: K, value: T[K]): void {
    const store = this.getStore()
    if (store) {
      store[key] = value
    }
  }
}
