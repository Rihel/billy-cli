import Cos from 'cos-nodejs-sdk-v5'
import type { StoragePresignedUrlModel } from '@repo/shared'
import { AppLogger } from '../../foundation/logger/app-logger.js'
import type {
  ObjectContent,
  ObjectRemoved,
  ObjectStorageConfig,
  ObjectStorageProvider,
} from '../types.js'

export const makeCosProvider = (
  config: ObjectStorageConfig,
  logger: AppLogger,
): ObjectStorageProvider => {
  let client: Cos
  return {
    async initial() {
      client = new Cos({
        SecretId: config.accessKeyId,
        SecretKey: config.secretAccessKey,
      })
      logger.info('COS object storage initialized')
    },
    async getObject({ key }) {
      const response = await client.getObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
      })
      return { key, body: response.Body as Buffer } satisfies ObjectContent
    },
    async getPresignedUrl(data) {
      return {
        key: data.key,
        url: client.getObjectUrl({
          Bucket: config.bucket,
          Region: config.region,
          Key: data.key,
          Method: 'PUT',
        }),
      } satisfies StoragePresignedUrlModel
    },
    async getDownloadUrl({ key }) {
      return {
        key,
        url: client.getObjectUrl({
          Bucket: config.bucket,
          Region: config.region,
          Key: key,
          Method: 'GET',
        }),
      } satisfies StoragePresignedUrlModel
    },
    async getTemporaryCredentials() {
      throw new Error('COS temporary credentials are not implemented')
    },
    async removeObject({ key }) {
      await client.deleteObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
      })
      return { key } satisfies ObjectRemoved
    },
  }
}
