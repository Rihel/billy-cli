import {
  CreateBucketCommand,
  DeleteBucketPolicyCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type {
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
      await ensurePrivateBucket(s3, config.bucket, logger)
      logger.info('S3 object storage initialized')
    },
    async getObject({ key }) {
      const response = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
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
    async getDownloadUrl({ key, filename, expiresIn }) {
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
          { expiresIn: expiresIn ?? 3600 },
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
      await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
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

/**
 * 桶默认**私有**（2026-11-14 评审整改）：
 *
 * 1. 保证桶存在（404 才创建）；
 * 2. **清掉任何历史遗留的公开读桶策略**（早期版本为 Office 预览直连自动打过
 *    `Principal:* + s3:GetObject`，等于「知道 key 就能下载」）；没有策略时忽略；
 * 3. 配 CORS（浏览器用**预签名 URL**直传 / 直读需要跨域）—— CORS 只描述"允许哪个源
 *    发起跨域请求"，不授予对象权限，桶私有后它仍然是安全的。
 *
 * 下载统一走服务端短期预签名 URL（`getDownloadUrl`），不再依赖桶的公开读。
 */
const ensurePrivateBucket = async (s3: S3Client, bucket: string, logger: AppLogger) => {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch (cause: unknown) {
    const status = (cause as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    if (status !== 404) throw cause
    await s3.send(new CreateBucketCommand({ Bucket: bucket }))
  }

  // 主动收紧：历史部署可能已被打过公开读策略，升级后要自愈成私有
  try {
    await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }))
  } catch (error) {
    // 没有桶策略 = 本来就是私有（S3 / MinIO 返回 NoSuchBucketPolicy），不是故障
    const code = (error as { name?: string })?.name
    if (code !== 'NoSuchBucketPolicy' && code !== 'NoSuchBucket') {
      logger.warn('S3 清理公开读桶策略失败，请检查桶权限', {
        bucket,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 前端直连 OSS 用预签名 URL（PUT 上传 / GET 预览），跨域必须放行这三个方法。
  // CORS 不授予对象权限：桶私有后，未带签名的 GET 依然会被拒。
  try {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: ['*'],
              AllowedMethods: ['GET', 'HEAD', 'PUT'],
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
