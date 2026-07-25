import { Inject, Injectable } from '@nestjs/common'
import type { OnApplicationBootstrap } from '@nestjs/common'
import { STORAGE_MODULE_OPTIONS } from './interface.js'
import type { StorageModuleOptions } from './interface.js'

@Injectable()
export class StorageConfig implements OnApplicationBootstrap {
  constructor(
    @Inject(STORAGE_MODULE_OPTIONS)
    private config: StorageModuleOptions,
  ) {}
  onApplicationBootstrap() {
    // console.log(this.configSvc.get('storage'))
  }
  get provider() {
    return this.config.provider
  }
  get region() {
    return this.config.region
  }
  get endpoint() {
    return this.config.endpoint
  }
  get accessKeyId() {
    return this.config.accessKeyId
  }
  get secretAccessKey() {
    return this.config.secretAccessKey
  }

  get bucket() {
    return this.config.bucket
  }
  get commonOptions() {
    return {
      region: this.region,
      endpoint: this.endpoint,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      },
    }
  }
}
