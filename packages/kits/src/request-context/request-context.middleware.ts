import { Inject, Injectable } from '@nestjs/common'
import type { NestMiddleware } from '@nestjs/common'
import { REQUEST_CONTEXT_OPTIONS } from './request-context.types.js'
import type { RequestContextOptions } from './request-context.types.js'
import { RequestContextService } from './request-context.service.js'

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    @Inject(REQUEST_CONTEXT_OPTIONS)
    private options: RequestContextOptions<any>,
    private requestContext: RequestContextService<any>,
  ) {}

  use(req: any, _res: any, next: (error?: Error | any) => void) {
    const storeOrPromise = this.options.defaultStoreFactory(req)
    if (storeOrPromise instanceof Promise) {
      storeOrPromise.then((store) => {
        this.requestContext.run(store, next)
      })
    } else {
      this.requestContext.run(storeOrPromise, next)
    }
  }
}
