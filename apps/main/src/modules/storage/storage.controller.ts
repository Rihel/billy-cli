import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import { GetStorageDownloadUrlSchema, GetStorageUploadPresignedUrlSchema } from '@repo/shared'
import type { GetStorageDownloadUrlDto, GetStorageUploadPresignedUrlDto } from '@repo/shared'
import { ObjectStorage } from '@repo/kits'
import { requestContext } from '../../common/index.js'
import { AnyAuthGuard } from '../auth/any-auth.guard.js'
import { StorageAdminOnlyError } from './errors.js'
import { assertDownloadKey, resolveUploadKey } from './storage-key.js'

/**
 * 对象存储路由（`/storage/*`）：
 *
 * - **鉴权**：`AnyAuthGuard`（前台用户或管理员）—— C 端用户要能传自己的头像 / 附件；
 * - **越权防护**：身份决定 key 策略（见 `storage-key.ts` 与 `docs/design/storage-access-policy.md`）：
 *   上传把用户 key 改写进 `user/{userId}/`，下载校验前缀，越界 403；
 * - **STS 例外**：`get-temporary-credentials` 仍**仅限管理员** —— `AssumeRole` 返回的是整桶权限的
 *   临时凭证（`providers/s3.ts`），与「前缀约束」不是一回事，发给 C 端等于把桶交出去
 *   （要放开需先在 provider 侧支持按前缀限定 policy，见设计文档「演进」）。
 *
 * 控制器只做边界：解析身份 → 应用 key 策略 → 调 kits 统一入口（`ObjectStorage`）。
 */
@Controller('storage')
@UseGuards(AnyAuthGuard)
export class StorageController {
  constructor(@Inject(ObjectStorage) private readonly storage: ObjectStorage) {}

  /**
   * 当前请求身份。
   *
   * 直接读 ALS 而**不用** `currentUserId()` / `currentAdminId()`：后者在身份缺失时抛错，
   * 而双身份模式下必然有一个缺失（用户没有 adminId、管理员没有 userId）；
   * 鉴权关闭（`AUTH_ENABLED=false`）时两个都没有，此时按「无前缀约束」处理，与既有姿态一致。
   */
  private identity(): { userId?: string; adminId?: string } {
    return {
      userId: requestContext.get('userId') ?? undefined,
      adminId: requestContext.get('adminId') ?? undefined,
    }
  }

  @Post('get-presigned-url')
  @HttpCode(200)
  getPresignedUrl(
    @Body({ schema: GetStorageUploadPresignedUrlSchema }) input: GetStorageUploadPresignedUrlDto,
  ) {
    const key = resolveUploadKey({ key: input.key, userId: this.identity().userId })
    return this.storage.getPresignedUrl({ ...input, key })
  }

  @Post('get-download-url')
  @HttpCode(200)
  getDownloadUrl(@Body({ schema: GetStorageDownloadUrlSchema }) input: GetStorageDownloadUrlDto) {
    assertDownloadKey({ key: input.key, userId: this.identity().userId })
    return this.storage.getDownloadUrl(input)
  }

  @Post('get-temporary-credentials')
  @HttpCode(200)
  getTemporaryCredentials() {
    const { adminId } = this.identity()
    // 整桶权限的临时凭证只发给管理员：前台用户拒绝；鉴权关闭（无身份）也不再放行 ——
    // 否则「AUTH_ENABLED=false 且服务对公网可达」时，任何人都能拿到桶级凭证。
    if (!adminId) throw new StorageAdminOnlyError()

    return this.storage.getTemporaryCredentials({ userId: adminId })
  }
}
