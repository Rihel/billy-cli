import { Injectable } from '@nestjs/common'
import {
  GetStorageUploadPresignedUrlDto,
  StoragePresignedUrlModel,
  StorageStsModel,
} from '@repo/shared'
import Cos from 'cos-nodejs-sdk-v5'
import type { z } from 'zod'
import { AppLoggerService } from '../logger.js'
import { StorageConfig } from './storage.config.js'
import type { StorageProvider } from './types.js'

@Injectable()
export class CosProvider implements StorageProvider {
  readonly providerName = 'cos'
  private storageClient!: Cos

  constructor(
    private readonly config: StorageConfig,
    private readonly logger: AppLoggerService,
  ) {}

  getTemporaryCredentials(): Promise<z.infer<typeof StorageStsModel>> {
    throw new Error('Method not implemented.')
  }

  async getObject(key: string) {
    const response = await this.storageClient.getObject({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: key,
    })
    return response.Body
  }

  getPresignedUrl(
    data: z.infer<typeof GetStorageUploadPresignedUrlDto>,
  ): Promise<z.infer<typeof StoragePresignedUrlModel>> {
    const url = this.storageClient.getObjectUrl({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: data.key,
      Method: 'PUT',
    })
    return Promise.resolve({ url, key: data.key })
  }

  async removeObject(key: string) {
    await this.storageClient.deleteObject({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: key,
    })
  }

  initial() {
    this.storageClient = new Cos({
      SecretId: this.config.accessKeyId,
      SecretKey: this.config.secretAccessKey,
    })
    this.logger.info('COS 存储服务初始化成功')
  }

  getDownloadUrl(
    key: string,
  ): Promise<z.infer<typeof StoragePresignedUrlModel>> {
    const url = this.storageClient.getObjectUrl({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: key,
      Method: 'GET',
    })
    return Promise.resolve({ url, key })
  }
}
