import Cos from 'cos-nodejs-sdk-v5';
import { Injectable } from '@nestjs/common';
import { StorageConfig } from '../storage.config.js';
import type { StorageProvider } from '../interface.js';
import { AppLoggerService } from '../../../infra/logger.service.js';
import {
  GetStorageUploadPresignedUrlDto,
  StoragePresignedUrlModel,
  StorageStsModel,
} from '@repo/shared';
import { z } from 'zod';

@Injectable()
export class CosProvider implements StorageProvider {
  providerName: string = 'cos';
  private storageClient: Cos;

  constructor(
    private config: StorageConfig,
    private logger: AppLoggerService,
  ) {}
  async getTemporaryCredentials(
    userId: string,
  ): Promise<z.infer<typeof StorageStsModel>> {
    throw new Error('Method not implemented.');
  }

  async getObject(key: string) {
    const res = await this.storageClient.getObject({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: key,
    });
    return res.Body;
  }

  getPresignedUrl(
    data: z.infer<typeof GetStorageUploadPresignedUrlDto>,
  ): Promise<z.infer<typeof StoragePresignedUrlModel>> {
    const url = this.storageClient.getObjectUrl({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: data.key,
      Method: 'PUT',
    });
    return Promise.resolve({
      url,
      key: data.key,
    });
  }
  async removeObject(key: string) {
    await this.storageClient.deleteObject({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: key,
    });
  }
  initial(): Promise<void> | void {
    this.storageClient = new Cos({
      SecretId: this.config.accessKeyId,
      SecretKey: this.config.secretAccessKey,
    });
    this.logger.info(`COS 存储服务初始化成功`);
  }
  getDownloadUrl(
    key: string,
  ): Promise<z.infer<typeof StoragePresignedUrlModel>> {
    const url = this.storageClient.getObjectUrl({
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: key,
      Method: 'GET',
    });
    return Promise.resolve({
      url,
      key: key,
    });
  }
}
