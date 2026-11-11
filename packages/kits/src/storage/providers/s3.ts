import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type {
  GetStorageDownloadUrlDto,
  GetStorageUploadPresignedUrlDto,
  GetTemporaryCredentialsDto,
  StoragePresignedUrlModel,
  StorageStsModel,
} from '@repo/shared'
import { AppLogger } from '../../foundation/logger/app-logger.js'
import type { RedisStore } from '../../redis/redis-store.js'
import type {
  ObjectContent,
  ObjectPut,
  ObjectRemoved,
  ObjectStorageConfig,
  ObjectStorageProvider,
  PutObjectInput,
} from '../types.js'

export const makeS3Provider = (
  config: ObjectStorageConfig,
  logger: AppLogger,
  redis: RedisStore,
): ObjectStorageProvider => {
  let s3: S3Client
  let sts: STSClient
  const options = {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: config.endpoint,
  }

  return {
    async initial() {
      s3 = new S3Client({ ...options, forcePathStyle: true })
      sts = new STSClient(options)
      yieldUnused(logger)
      await ensurePublicReadBucket(s3, config.bucket, logger)
      logger.info('S3 object storage initialized')
    },
    async getObject({ key }) {
      const response = await s3.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      )
      return {
        key,
        body: Buffer.from((await response.Body?.transformToByteArray()) ?? []),
      } satisfies ObjectContent
    },
    async putObject(input: PutObjectInput) {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          Body: input.body,
          ContentLength: input.body.length,
          ...(input.contentType ? { ContentType: input.contentType } : {}),
        }),
      )
      return { key: input.key } satisfies ObjectPut
    },
    async getPresignedUrl(data) {
      return {
        key: data.key,
        url: await getSignedUrl(
          s3,
          new PutObjectCommand({ Bucket: config.bucket, Key: data.key }),
          { expiresIn: 3600 },
        ),
      } satisfies StoragePresignedUrlModel
    },
    async getDownloadUrl({ key, filename }) {
      const disposition = attachmentDisposition(filename)
      return {
        key,
        url: await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: key,
            ...(disposition ? { ResponseContentDisposition: disposition } : {}),
          }),
          { expiresIn: 3600 },
        ),
      } satisfies StoragePresignedUrlModel
    },
    async getTemporaryCredentials(request: GetTemporaryCredentialsDto) {
      const cacheKey = `temp-credential:${request.userId}`
      const cached = await redis.raw.get(cacheKey)
      if (cached) return JSON.parse(cached) as StorageStsModel
      const response = await sts.send(
        new AssumeRoleCommand({
          RoleArn: `arn:aws:iam::${config.accessKeyId}:role/role-name`,
          RoleSessionName: request.userId,
          DurationSeconds: 3600,
        }),
      )
      const credentials = response.Credentials
      if (!credentials) throw new Error('STS did not return credentials')
      const result: StorageStsModel = {
        endpoint: config.endpoint ?? '',
        bucket: config.bucket,
        region: config.region,
        accessKeyId: credentials.AccessKeyId!,
        secretAccessKey: credentials.SecretAccessKey!,
        sessionToken: credentials.SessionToken!,
        expiration: Math.floor(credentials.Expiration!.getTime() / 1000),
      }
      await redis.raw.set(cacheKey, JSON.stringify(result), 'EX', 3600)
      return result
    },
    async removeObject({ key }) {
      await s3.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      )
      return { key } satisfies ObjectRemoved
    },
    async listObjects({ prefix, max = 1000 }) {
      const items: Array<{ key: string; lastModified: Date }> = []
      let token: string | undefined
      do {
        const response = await s3.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            MaxKeys: Math.min(1000, max - items.length),
            ...(token ? { ContinuationToken: token } : {}),
          }),
        )
        for (const object of response.Contents ?? []) {
          if (!object.Key || !object.LastModified) continue
          items.push({ key: object.Key, lastModified: object.LastModified })
          if (items.length >= max) break
        }
        token = items.length >= max ? undefined : response.NextContinuationToken
      } while (token)
      return items
    },
  }
}

const yieldUnused = (_value: unknown) => undefined

const ensurePublicReadBucket = async (s3: S3Client, bucket: string, logger: AppLogger) => {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch (cause: unknown) {
    const status = (cause as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode
    if (status !== 404) throw cause
    await s3.send(new CreateBucketCommand({ Bucket: bucket }))
  }
  await s3.send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${bucket}/*`],
          },
        ],
      }),
    }),
  )

  // 前端直连 OSS 拿文件流（Office / PPTX 预览）需要桶 CORS；没有它 fetch 会被浏览器拦。
  // 只开放 GET / HEAD，且桶本身已是 public-read，这里不扩大对象权限。
  try {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: ['*'],
              AllowedMethods: ['GET', 'HEAD'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range'],
              MaxAgeSeconds: 86400,
            },
          ],
        },
      }),
    )
  } catch (error) {
    logger.warn('S3 CORS 配置失败，前端直连 OSS 可能被浏览器拦截', {
      bucket,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** 下载头的文件名清洗：去掉 CR/LF / 引号 / 反斜杠，防 header 注入 */
const attachmentDisposition = (filename?: string): string | undefined => {
  const safe = filename?.replace(/[\r\n"\\]/g, '_').trim()
  if (!safe) return undefined
  return `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`
}
