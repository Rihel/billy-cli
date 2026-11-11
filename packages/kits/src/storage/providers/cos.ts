import Cos from 'cos-nodejs-sdk-v5'
import type { StoragePresignedUrlModel } from '@repo/shared'
import { AppLogger } from '../../foundation/logger/app-logger.js'
import type {
  ObjectContent,
  ObjectPut,
  ObjectRemoved,
  ObjectStorageConfig,
  ObjectStorageProvider,
  PutObjectInput,
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
    async putObject(input: PutObjectInput) {
      await client.putObject({
        Bucket: config.bucket,
        Region: config.region,
        Key: input.key,
        Body: input.body,
        ContentLength: input.body.length,
        ...(input.contentType ? { ContentType: input.contentType } : {}),
      })
      return { key: input.key } satisfies ObjectPut
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
    async getDownloadUrl({ key, filename }) {
      const url = client.getObjectUrl({
        Bucket: config.bucket,
        Region: config.region,
        Key: key,
        Method: 'GET',
      })
      const safe = filename?.replace(/[\r\n"\\]/g, '_').trim()
      if (!safe) return { key, url } satisfies StoragePresignedUrlModel
      const separator = url.includes('?') ? '&' : '?'
      return {
        key,
        url: `${url}${separator}response-content-disposition=${encodeURIComponent(
          `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`,
        )}`,
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
