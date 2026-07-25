import { BadRequestException, Injectable } from '@nestjs/common'
import type { OnApplicationBootstrap } from '@nestjs/common'

import { CosProvider } from './providers/cos.provider.js'
import { S3Provider } from './providers/s3.provider.js'
import { StorageConfig } from './storage.config.js'
import type { StorageProvider } from './interface.js'

@Injectable()
export class StorageService implements OnApplicationBootstrap {
  private providers: Record<string, StorageProvider>
  constructor(
    private config: StorageConfig,
    private s3Provider: S3Provider,
    private cosProvider: CosProvider,
  ) {
    this.providers = {
      s3: this.s3Provider,
      cos: this.cosProvider,
    }
  }
  getProvider(providerName: string = this.config.provider): StorageProvider {
    const provider = this.providers[providerName]
    if (!provider) {
      throw new BadRequestException('不支持的存储服务')
    }
    return provider
  }

  async getObject(key: string, providerName?: string): Promise<Uint8Array> {
    return await this.getProvider(providerName).getObject(key)
  }

  async onApplicationBootstrap() {
    await this.getProvider().initial()
  }
}
