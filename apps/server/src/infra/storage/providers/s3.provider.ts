import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { S3ClientConfig } from '@aws-sdk/client-s3';

import { StorageConfig } from '../storage.config.js';
import type { StorageProvider } from '../interface.js';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppLoggerService } from '../../../infra/logger.service.js';
import { RedisService } from '../../../infra/redis.service.js';
import { z } from 'zod';
import { GetStorageUploadPresignedUrlDto, StorageStsModel } from '@repo/shared';

@Injectable()
export class S3Provider implements StorageProvider {
  providerName: string = 's3';
  private storageClient!: S3Client;
  private stsClient!: STSClient;

  constructor(
    private config: StorageConfig,
    private redisService: RedisService,
    private logger: AppLoggerService,
  ) {}
  async getDownloadUrl(key: string) {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      // 可选：可以添加其他元数据或 ACL 设置
      // ACL: "public-read",
    });

    // 生成预签名 URL，有效期为 1 小时
    const signedUrl = await getSignedUrl(this.storageClient, command, {
      expiresIn: 3600,
    });
    return {
      url: signedUrl,
      key,
    };
  }

  async initial() {
    const options: S3ClientConfig = {
      ...this.config.commonOptions,
      forcePathStyle: true,
    };
    this.storageClient = new S3Client(options);
    this.stsClient = new STSClient({
      ...this.config.commonOptions,
    });
    this.logger.info('初始化存储服务');
  }

  async getObject(key: string) {
    const res = await this.storageClient.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );

    const data = await res.Body?.transformToByteArray();
    const buffer = Buffer.from(data!);
    return buffer;
  }

  async getTemporaryCredentials(
    userId: string,
  ): Promise<z.infer<typeof StorageStsModel>> {
    try {
      const roleSessionName = userId;
      const key = `temp-credential:${roleSessionName}`;
      this.logger.info('临时秘钥缓存key：' + key);
      try {
        const value = (await this.redisService.get2Json(key)) as z.infer<
          typeof StorageStsModel
        > | null;
        this.logger.info('临时秘钥缓存值');

        if (value) {
          return value;
        }
      } catch (error) {
        this.logger.warn(`获取缓存的临时秘钥失败：${(error as Error).message}`);
      }
      const roleArn = `arn:aws:iam::${this.config.accessKeyId}:role/role-name`; // 替换为你的角色 ARN
      const assumeRoleParams = {
        RoleArn: roleArn,
        RoleSessionName: roleSessionName,
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
        DurationSeconds: 3600, // 临时凭证有效时间（秒）
      };
      const assumeRoleCommand = new AssumeRoleCommand(assumeRoleParams);

      const assumeRoleResponse = await this.stsClient.send(assumeRoleCommand);

      const res = {
        endpoint: this.config.endpoint,
        bucket: this.config.bucket,
        region: this.config.region,
        accessKeyId: assumeRoleResponse.Credentials?.AccessKeyId!,
        secretAccessKey: assumeRoleResponse.Credentials?.SecretAccessKey!,
        sessionToken: assumeRoleResponse.Credentials?.SessionToken!,
        expiration: Math.floor(
          assumeRoleResponse.Credentials?.Expiration?.getTime()! / 1000,
        ),
      } as z.infer<typeof StorageStsModel>;

      await this.redisService.setByJsonAndExpire(key, res, 3600);
      return res;
    } catch (err) {
      console.log(err);
      this.logger.error(`获取临时凭证失败: ${(err as Error).message}`);
      this.logger.error((err as Error).stack);
      throw new BadRequestException(
        `获取临时凭证失败: ${(err as Error).message}`,
      );
    }
  }

  async getPresignedUrl(data: z.infer<typeof GetStorageUploadPresignedUrlDto>) {
    // 创建 PutObjectCommand
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: data.key,
      // 可选：可以添加其他元数据或 ACL 设置
      // ACL: "public-read",
    });

    // 生成预签名 URL，有效期为 1 小时
    const signedUrl = await getSignedUrl(this.storageClient, command, {
      expiresIn: 3600,
    });

    return {
      key: data.key,
      url: signedUrl,
    };
  }

  async removeObject(key: string) {
    await this.storageClient.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );
  }
}
