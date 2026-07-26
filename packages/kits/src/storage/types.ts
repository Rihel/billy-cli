import type {
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
} from '@nestjs/common'
import {
  GetStorageUploadPresignedUrlDto,
  StoragePresignedUrlModel,
  StorageStsModel,
} from '@repo/shared'
import type { z } from 'zod'

export interface StorageProvider {
  providerName: string
  getTemporaryCredentials(
    userId: string,
  ): Promise<z.infer<typeof StorageStsModel>>
  getObject(key: string): Promise<Buffer>
  getPresignedUrl(
    data: z.infer<typeof GetStorageUploadPresignedUrlDto>,
  ): Promise<z.infer<typeof StoragePresignedUrlModel>>
  removeObject(key: string): Promise<void>
  initial(): Promise<void> | void
  getDownloadUrl(key: string): Promise<z.infer<typeof StoragePresignedUrlModel>>
}

export interface StorageModuleOptions {
  provider: 's3' | 'cos' | string
  region: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

export const STORAGE_MODULE_OPTIONS = Symbol('STORAGE_MODULE_OPTIONS')

export interface StorageModuleAsyncOptions extends Pick<
  ModuleMetadata,
  'imports'
> {
  useFactory: (
    ...args: unknown[]
  ) => Promise<StorageModuleOptions> | StorageModuleOptions
  inject?: InjectionToken[]
}

export type StorageDynamicModule = DynamicModule
