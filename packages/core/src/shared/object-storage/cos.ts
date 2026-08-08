import Cos from 'cos-nodejs-sdk-v5'
import type { ApplicationLoggerApi } from '../application-logger.capability.js'
import type { ObjectStorageConfig, ObjectStorageProvider } from './types.js'
import { ObjectContent, ObjectRemoved, PresignedObjectUrl } from './domain.js'

export const makeCosProvider = (
  config: ObjectStorageConfig,
  logger: ApplicationLoggerApi,
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
      return new ObjectContent({ key, body: response.Body as Buffer })
    },
    async getPresignedUrl(data) {
      return new PresignedObjectUrl({
        key: data.key,
        url: client.getObjectUrl({
          Bucket: config.bucket,
          Region: config.region,
          Key: data.key,
          Method: 'PUT',
        }),
      })
    },
    async getDownloadUrl({ key }) {
      return new PresignedObjectUrl({
        key,
        url: client.getObjectUrl({
          Bucket: config.bucket,
          Region: config.region,
          Key: key,
          Method: 'GET',
        }),
      })
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
      return new ObjectRemoved({ key })
    },
  }
}
