import {
  StorageStsModel,
  GetStorageUploadPresignedUrlDto,
  StoragePresignedUrlModel,
} from '@repo/shared';
import { z } from 'zod';

export interface StorageProvider {
  providerName: string;
  getTemporaryCredentials(
    userId: string,
  ): Promise<z.infer<typeof StorageStsModel>>;
  getObject(key: string): Promise<Buffer>;
  getPresignedUrl(
    data: z.infer<typeof GetStorageUploadPresignedUrlDto>,
  ): Promise<z.infer<typeof StoragePresignedUrlModel>>;
  removeObject(key: string): Promise<void>;
  initial(): Promise<void> | void;
  getDownloadUrl(
    key: string,
  ): Promise<z.infer<typeof StoragePresignedUrlModel>>;
}
export type StorageModuleOptions = {
  provider: 's3' | 'cos' | string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};
export const STORAGE_MODULE_OPTIONS = Symbol('STORAGE_MODULE_OPTIONS');

export type StorageModuleAsyncOptions = {
  useFactory: (
    ...args: any[]
  ) => Promise<StorageModuleOptions> | StorageModuleOptions;
  inject?: any[];
  imports?: any[];
};
