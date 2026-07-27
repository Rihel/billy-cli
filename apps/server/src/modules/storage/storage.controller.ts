import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { StorageService } from '@repo/kits';
import {
  GetStorageUploadPresignedUrlDto,
  GetStorageDownloadUrlDto,
} from '@repo/shared';
import { z } from 'zod';
import { AuthGuard } from '../../guards/auth.guard.js';
import { UserId } from '../../decorators/user-id.decorator.js';

@Controller('api/storage')
@UseGuards(AuthGuard)
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Post('get-presigned-url')
  async getPresignedUrl(
    @Body() dto: z.infer<typeof GetStorageUploadPresignedUrlDto>,
  ) {
    return await this.storageService.getProvider().getPresignedUrl(dto);
  }

  @Post('get-download-url')
  async getDownloadUrl(
    @Body() dto: z.infer<typeof GetStorageDownloadUrlDto>,
  ) {
    return await this.storageService.getProvider().getDownloadUrl(dto.key);
  }

  @Post('get-temporary-credentials')
  async getTemporaryCredentials(@UserId() userId: string) {
    return await this.storageService
      .getProvider()
      .getTemporaryCredentials(userId);
  }
}
