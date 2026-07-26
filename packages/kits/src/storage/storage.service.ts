import {
  BadRequestException,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common'
import { CosProvider } from './cos.provider.js'
import { S3Provider } from './s3.provider.js'
import { StorageConfig } from './storage.config.js'
import type { StorageProvider } from './types.js'

@Injectable()
export class StorageService implements OnApplicationBootstrap {
  private readonly providers: Record<string, StorageProvider>

  constructor(
    private readonly config: StorageConfig,
    s3Provider: S3Provider,
    cosProvider: CosProvider,
  ) {
    this.providers = { s3: s3Provider, cos: cosProvider }
  }

  getProvider(providerName = this.config.provider): StorageProvider {
    const provider = this.providers[providerName]
    if (!provider) throw new BadRequestException('不支持的存储服务')
    return provider
  }

  async getObject(key: string, providerName?: string): Promise<Uint8Array> {
    return this.getProvider(providerName).getObject(key)
  }

  async onApplicationBootstrap() {
    await this.getProvider().initial()
  }
}
