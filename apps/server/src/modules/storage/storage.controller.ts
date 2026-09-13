import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  GetStorageDownloadUrlSchema,
  GetStorageUploadPresignedUrlSchema,
} from '@repo/shared'
import type {
  GetStorageDownloadUrlDto,
  GetStorageUploadPresignedUrlDto,
} from '@repo/shared'
import { ObjectStorage } from '@repo/kits'
import { currentAdminId } from '../../common/index.js'
import { AdminAuthGuard } from '../admin/admin-auth.guard.js'

/** 对象存储路由（/storage/*，全部后台管理员鉴权）：预签名上传 / 下载 + STS 临时凭证 */
@Controller('storage')
@UseGuards(AdminAuthGuard)
export class StorageController {
  constructor(@Inject(ObjectStorage) private readonly storage: ObjectStorage) {}

  @Post('get-presigned-url')
  @HttpCode(200)
  getPresignedUrl(
    @Body({ schema: GetStorageUploadPresignedUrlSchema }) input: GetStorageUploadPresignedUrlDto,
  ) {
    return this.storage.getPresignedUrl(input)
  }

  @Post('get-download-url')
  @HttpCode(200)
  getDownloadUrl(
    @Body({ schema: GetStorageDownloadUrlSchema }) input: GetStorageDownloadUrlDto,
  ) {
    return this.storage.getDownloadUrl(input)
  }

  @Post('get-temporary-credentials')
  @HttpCode(200)
  getTemporaryCredentials() {
    return this.storage.getTemporaryCredentials({ userId: currentAdminId() })
  }
}
