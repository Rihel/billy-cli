import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { ApplicationLoggerApi } from '../application-logger.capability.js'
import type { RedisStoreApi } from '../redis-store.capability.js'
import type { ObjectStorageConfig, ObjectStorageProvider } from './types.js'
import {
  ObjectContent,
  ObjectRemoved,
  PresignedObjectUrl,
  TemporaryCredentials,
} from './domain.js'

export const makeS3Provider = (
  config: ObjectStorageConfig,
  logger: ApplicationLoggerApi,
  redis: RedisStoreApi,
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
      await ensurePublicReadBucket(s3, config.bucket)
      logger.info('S3 object storage initialized')
    },
    async getObject({ key }) {
      const response = await s3.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      )
      return new ObjectContent({
        key,
        body: Buffer.from((await response.Body?.transformToByteArray()) ?? []),
      })
    },
    async getPresignedUrl(data) {
      return new PresignedObjectUrl({
        key: data.key,
        url: await getSignedUrl(
          s3,
          new PutObjectCommand({ Bucket: config.bucket, Key: data.key }),
          { expiresIn: 3600 },
        ),
      })
    },
    async getDownloadUrl({ key }) {
      return new PresignedObjectUrl({
        key,
        url: await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: config.bucket, Key: key }),
          { expiresIn: 3600 },
        ),
      })
    },
    async getTemporaryCredentials({ userId }) {
      const cacheKey = `temp-credential:${userId}`
      const cached = await redis.raw.get(cacheKey)
      if (cached) return new TemporaryCredentials(JSON.parse(cached))
      const response = await sts.send(
        new AssumeRoleCommand({
          RoleArn: `arn:aws:iam::${config.accessKeyId}:role/role-name`,
          RoleSessionName: userId,
          DurationSeconds: 3600,
        }),
      )
      const credentials = response.Credentials
      if (!credentials) throw new Error('STS did not return credentials')
      const result = new TemporaryCredentials({
        endpoint: config.endpoint ?? '',
        bucket: config.bucket,
        region: config.region,
        accessKeyId: credentials.AccessKeyId!,
        secretAccessKey: credentials.SecretAccessKey!,
        sessionToken: credentials.SessionToken!,
        expiration: Math.floor(credentials.Expiration!.getTime() / 1000),
      })
      await redis.raw.set(cacheKey, JSON.stringify(result), 'EX', 3600)
      return result
    },
    async removeObject({ key }) {
      await s3.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      )
      return new ObjectRemoved({ key })
    },
  }
}

const yieldUnused = (_value: unknown) => undefined

const ensurePublicReadBucket = async (s3: S3Client, bucket: string) => {
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
}
