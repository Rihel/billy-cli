import { AsyncLocalStorage } from 'async_hooks'
import { Inject, Injectable } from '@nestjs/common'
import { AppLoggerService } from '../logger/logger.service.js'

@Injectable()
export class RequestContextService<T extends Record<string, any> = Record<string, any>> {
  private als = new AsyncLocalStorage<T>()

  constructor(
    @Inject(AppLoggerService) private readonly logger: AppLoggerService,
  ) {
    this.logger.setContext(RequestContextService.name)
  }

  run(store: T, callback: () => void) {
    this.als.run(store, callback)
  }

  getStore(): T | undefined {
    return this.als.getStore()
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
