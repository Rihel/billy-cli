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
import { GetStorageUploadPresignedUrlDto } from '@repo/shared'
import type { z } from 'zod'
import type { ILogger } from '../logger.service.js'
import type { IRedis } from '../redis.service.js'
import type { IStorageProvider, StorageProviderConfig } from './types.js'

export function makeS3Provider(
  config: StorageProviderConfig,
  logger: ILogger,
  redis?: IRedis,
): IStorageProvider {
  let s3: S3Client
  let sts: STSClient
  const commonOptions = {
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    endpoint: config.endpoint,
  }

  return {
    providerName: 's3',

    async initial() {
      s3 = new S3Client({ ...commonOptions, forcePathStyle: true })
      sts = new STSClient(commonOptions)
      await ensurePublicReadBucket(s3, config.bucket)
      logger.info('S3 存储服务初始化成功')
    },

    async getObject(key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
      return Buffer.from((await res.Body?.transformToByteArray()) ?? [])
    },

    async getPresignedUrl(data: z.infer<typeof GetStorageUploadPresignedUrlDto>) {
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: config.bucket, Key: data.key }),
        { expiresIn: 3600 },
      )
      return { key: data.key, url }
    },

    async getDownloadUrl(key) {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        { expiresIn: 3600 },
      )
      return { key, url }
    },

    async getTemporaryCredentials(userId) {
      const cacheKey = `temp-credential:${userId}`

      if (redis) {
        const cached = await redis.raw.get(cacheKey)
        if (cached) {
          try { return JSON.parse(cached) } catch {}
        }
      }

      const res = await sts.send(
        new AssumeRoleCommand({
          RoleArn: `arn:aws:iam::${config.accessKeyId}:role/role-name`,
          RoleSessionName: userId,
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Action: ['s3:PutObject', 's3:ListBucket', 's3:GetObject'],
              Resource: [`arn:aws:s3:::${config.bucket}`, `arn:aws:s3:::${config.bucket}/*`],
            }],
          }),
          DurationSeconds: 3600,
        }),
      )
      const creds = res.Credentials
      if (!creds) throw new Error('STS 未返回临时凭证')
      const result = {
        endpoint: config.endpoint,
        bucket: config.bucket,
        region: config.region,
        accessKeyId: creds.AccessKeyId!,
        secretAccessKey: creds.SecretAccessKey!,
        sessionToken: creds.SessionToken!,
        expiration: Math.floor(creds.Expiration!.getTime() / 1000),
      }

      if (redis) await redis.raw.set(cacheKey, JSON.stringify(result), 'EX', 3600)
      return result
    },

    async removeObject(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
    },
  }
}

async function ensurePublicReadBucket(s3: S3Client, bucket: string) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch (err: any) {
    if (err?.$metadata?.httpStatusCode !== 404) throw err
    await s3.send(new CreateBucketCommand({ Bucket: bucket }))
  }
  await s3.send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Sid: 'PublicReadObjects',
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucket}/*`],
        }],
      }),
    }),
  )
}
