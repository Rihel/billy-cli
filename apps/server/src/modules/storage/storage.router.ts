import { Ctx, Input, Query, Router, UseMiddlewares } from 'nestjs-trpc';
import { StorageService } from './storage.service.js';
import { AuthMiddleware } from '../../middlewares/auth.middleware.js';
import {
  GetStorageUploadPresignedUrlDto,
  GetStorageDownloadUrlDto,
} from '@repo/shared';
import { z } from 'zod';
import { Post } from '@nestjs/common';
import { ContextData } from '../../trpc.context.js';

@Router({ alias: 'storage' })
@UseMiddlewares(AuthMiddleware)
export class StorageRouter {
  constructor(private readonly storageService: StorageService) {}

  @Query({ input: GetStorageUploadPresignedUrlDto })
  async getPresignedUrl(
    @Input() dto: z.infer<typeof GetStorageUploadPresignedUrlDto>,
  ) {
    return await this.storageService.getProvider().getPresignedUrl(dto);
  }

  @Query({ input: GetStorageDownloadUrlDto })
  async getDownloadUrl(@Input() dto: z.infer<typeof GetStorageDownloadUrlDto>) {
    return await this.storageService.getProvider().getDownloadUrl(dto.key);
  }

  @Query({})
  async getTemporaryCredentials(@Ctx() ctx: z.infer<typeof ContextData>) {
    return await this.storageService
      .getProvider()
      .getTemporaryCredentials(ctx.userId);
  }
}
