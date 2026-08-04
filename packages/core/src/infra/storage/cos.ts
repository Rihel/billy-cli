import Cos from 'cos-nodejs-sdk-v5'
import type { GetStorageUploadPresignedUrlDto } from '@repo/shared'
import type { z } from 'zod'
import type { ILogger } from '../logger.service.js'
import type { IStorageProvider, StorageProviderConfig } from './types.js'

export function makeCosProvider(
  config: StorageProviderConfig,
  logger: ILogger,
): IStorageProvider {
  let client: Cos

  return {
    providerName: 'cos',

    async initial() {
      client = new Cos({
        SecretId: config.accessKeyId,
        SecretKey: config.secretAccessKey,
      })
      logger.info('COS 存储服务初始化成功')
    },

    async getObject(key) {
      const res = await client.getObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
      })
      return res.Body as Buffer
    },

    async getPresignedUrl(
      data: z.infer<typeof GetStorageUploadPresignedUrlDto>,
    ) {
      const url = client.getObjectUrl({
        Bucket: config.bucket,
        Region: config.region,
        Key: data.key,
        Method: 'PUT',
      })
      return { url, key: data.key }
    },

    async getDownloadUrl(key) {
      const url = client.getObjectUrl({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
        Method: 'GET',
      })
      return { url, key }
    },

    getTemporaryCredentials() {
      return Promise.reject(
        new Error('COS temporary credentials not implemented'),
      )
    },

    async removeObject(key) {
      await client.deleteObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
      })
    },
  }
}
