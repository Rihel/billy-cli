import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { BadRequestException, Injectable, Optional } from '@nestjs/common'
import { GetStorageUploadPresignedUrlDto, StorageStsModel } from '@repo/shared'
import type { z } from 'zod'
import { AppLoggerService } from '../logger.js'
import { RedisService } from '../redis.js'
import { StorageConfig } from './storage.config.js'
import type { StorageProvider } from './types.js'

@Injectable()
export class S3Provider implements StorageProvider {
  readonly providerName = 's3'
  private storageClient!: S3Client
  private stsClient!: STSClient

  constructor(
    private readonly config: StorageConfig,
    private readonly logger: AppLoggerService,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  async getDownloadUrl(key: string) {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
    })
    const url = await getSignedUrl(this.storageClient, command, {
      expiresIn: 3600,
    })
    return { url, key }
  }

  async initial() {
    const options: S3ClientConfig = {
      ...this.config.commonOptions,
      forcePathStyle: true,
    }
    this.storageClient = new S3Client(options)
    this.stsClient = new STSClient(this.config.commonOptions)
    await this.ensurePublicReadBucket()
    this.logger.info('初始化存储服务')
  }

  private async ensurePublicReadBucket() {
    try {
      await this.storageClient.send(
        new HeadBucketCommand({ Bucket: this.config.bucket }),
      )
    } catch (error) {
      const statusCode = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode
      if (statusCode !== 404) throw error
      await this.storageClient.send(
        new CreateBucketCommand({ Bucket: this.config.bucket }),
      )
    }

    await this.storageClient.send(
      new PutBucketPolicyCommand({
        Bucket: this.config.bucket,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'PublicReadObjects',
              Effect: 'Allow',
              Principal: '*',
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${this.config.bucket}/*`],
            },
          ],
        }),
      }),
    )
  }

  async getObject(key: string) {
    const response = await this.storageClient.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    )
    return Buffer.from((await response.Body?.transformToByteArray()) ?? [])
  }

  async getTemporaryCredentials(
    userId: string,
  ): Promise<z.infer<typeof StorageStsModel>> {
    try {
      const key = `temp-credential:${userId}`
      const cached =
        await this.redisService?.getJson<z.infer<typeof StorageStsModel>>(key)
      if (cached) return cached

      const response = await this.stsClient.send(
        new AssumeRoleCommand({
          RoleArn: `arn:aws:iam::${this.config.accessKeyId}:role/role-name`,
          RoleSessionName: userId,
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['s3:PutObject', 's3:ListBucket', 's3:GetObject'],
                Resource: [
                  `arn:aws:s3:::${this.config.bucket}`,
                  `arn:aws:s3:::${this.config.bucket}/*`,
                ],
              },
            ],
          }),
          DurationSeconds: 3600,
        }),
      )
      const credentials = response.Credentials
      if (!credentials) throw new Error('STS 未返回临时凭证')
      const result = {
        endpoint: this.config.endpoint,
        bucket: this.config.bucket,
        region: this.config.region,
        accessKeyId: credentials.AccessKeyId!,
        secretAccessKey: credentials.SecretAccessKey!,
        sessionToken: credentials.SessionToken!,
        expiration: Math.floor(credentials.Expiration!.getTime() / 1000),
      }
      await this.redisService?.setJson(key, result, 3600)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`获取临时凭证失败: ${message}`)
      throw new BadRequestException(`获取临时凭证失败: ${message}`)
    }
  }

  async getPresignedUrl(data: z.infer<typeof GetStorageUploadPresignedUrlDto>) {
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: data.key,
    })
    const url = await getSignedUrl(this.storageClient, command, {
      expiresIn: 3600,
    })
    return { key: data.key, url }
  }

  async removeObject(key: string) {
    await this.storageClient.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    )
  }
}
