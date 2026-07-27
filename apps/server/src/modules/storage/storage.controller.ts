import { Controller, Post, UseGuards } from '@nestjs/common';
import { StorageService } from '@repo/kits';
import {
  GetStorageUploadPresignedUrlDto,
  GetStorageDownloadUrlDto,
} from '@repo/shared';
import type { z } from 'zod';
import { ZBody } from 'nest-zod';
import { AuthGuard } from '../../guards/auth.guard.js';
import { RequestContext } from '@repo/kits';

@Controller('storage')
@UseGuards(AuthGuard)
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Post('get-presigned-url')
  async getPresignedUrl(
    @ZBody(GetStorageUploadPresignedUrlDto) dto: z.infer<typeof GetStorageUploadPresignedUrlDto>,
  ) {
    return await this.storageService.getProvider().getPresignedUrl(dto);
  }

  @Post('get-download-url')
  async getDownloadUrl(@ZBody(GetStorageDownloadUrlDto) dto: z.infer<typeof GetStorageDownloadUrlDto>) {
    return await this.storageService.getProvider().getDownloadUrl(dto.key);
  }

  @Post('get-temporary-credentials')
  async getTemporaryCredentials(@RequestContext('userId') userId: string) {
    return await this.storageService
      .getProvider()
      .getTemporaryCredentials(userId);
  }
}
