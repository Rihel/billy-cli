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
      // 前端直连 OSS 拿文件流（Office / PPTX 预览）需要桶 CORS；失败只告警不拦启动
      try {
        await client.putBucketCors({
          Bucket: config.bucket,
          Region: config.region,
          CORSRules: [
            {
              AllowedOrigin: ['*'],
              AllowedMethod: ['GET', 'HEAD'],
              AllowedHeader: ['*'],
              ExposeHeader: ['ETag', 'Content-Length', 'Content-Range'],
              MaxAgeSeconds: 86400,
            },
          ],
        })
      } catch (error) {
        logger.warn('COS CORS 配置失败，前端直连 OSS 可能被浏览器拦截', {
          bucket: config.bucket,
          error: error instanceof Error ? error.message : String(error),
        })
      }
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
    async listObjects({ prefix, max = 1000 }) {
      const items: Array<{ key: string; lastModified: Date }> = []
      let marker: string | undefined
      for (;;) {
        const response = await client.getBucket({
          Bucket: config.bucket,
          Region: config.region,
          Prefix: prefix,
          MaxKeys: Math.min(1000, max - items.length),
          ...(marker ? { Marker: marker } : {}),
        })
        for (const object of response.Contents ?? []) {
          if (!object.Key || !object.LastModified) continue
          items.push({ key: object.Key, lastModified: new Date(object.LastModified) })
          if (items.length >= max) break
        }
        if (items.length >= max || !response.IsTruncated) break
        marker = response.NextMarker
        if (!marker) break
      }
      return items
    },
  }
}
