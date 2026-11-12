import { timingSafeEqual } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  resolvePreviewKind,
  type CreateShareDto,
  type CreateShareModel,
  type ListShareDto,
  type ListShareModel,
  type ShareItemModel,
  type ShareMetaModel,
  type ShareResolveModel,
  type ShareTokenDto,
  type SuccessResultModel,
} from '@repo/shared'
import { ObjectStorage } from '@repo/kits'
import type { ServerAppConfig } from '../../app-config.js'
import type { AiFileEntity } from '../../database/entities/ai-file-entity.js'
import type { FileShareEntity } from '../../database/entities/file-share-entity.js'
import {
  ShareExpiryInvalidError,
  ShareFileNotFoundError,
  ShareForbiddenError,
  ShareLinkInvalidError,
} from './share.errors.js'
import { ShareRepository } from './share.repository.js'
import { createShareToken, hashShareToken, shareState } from './share.token.js'

/** 请求身份：管理员优先；都没有 = 鉴权关闭（`AUTH_ENABLED=false`），按管理员姿态处理 */
export type ShareIdentity = { adminId?: string; userId?: string }

/** 预签名 URL 只给 Next 用一次，有效期压到最短 */
const RESOLVE_URL_TTL_SECONDS = 300

/** 调用方没传 `expiresAt` 时的兜底有效期（7 天）；前端正常都会传 */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60

@Injectable()
export class ShareService {
  constructor(
    @Inject(ShareRepository) private readonly repo: ShareRepository,
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  private get settings(): ServerAppConfig['share'] {
    return this.config.getOrThrow<ServerAppConfig['share']>('share')
  }

  /** 生成分享 token（登录态）：完整链接由调用方用自己的域名拼 */
  async create(identity: ShareIdentity, input: CreateShareDto): Promise<CreateShareModel> {
    const file = await this.repo.findFile(input.fileId)
    if (!file) throw new ShareFileNotFoundError()
    this.assertCanShare(identity, file)

    const expiresAt =
      input.expiresAt === undefined
        ? new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000)
        : input.expiresAt === null
          ? null
          : new Date(input.expiresAt)
    // 用户自己填时间，服务端必须校验：过去的时间等于「生成了就失效」
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new ShareExpiryInvalidError()
    }
    const token = createShareToken()

    const row = await this.repo.create({
      tokenHash: hashShareToken(token),
      fileId: file.id,
      createdBy: identity.adminId ?? identity.userId ?? null,
      expiresAt,
    })

    // 明文 token 只在这里出现一次，之后任何接口都不再返回
    return {
      id: row.id,
      token,
      expiresAt: expiresAt?.getTime() ?? null,
    }
  }

  /** 某个文件的历史分享（不含 token） */
  async list(identity: ShareIdentity, input: ListShareDto): Promise<ListShareModel> {
    const file = await this.repo.findFile(input.fileId)
    if (!file) throw new ShareFileNotFoundError()
    this.assertCanShare(identity, file)

    const rows = await this.repo.listByFile(file.id)
    const now = Date.now()
    return { items: rows.map((row) => this.toItem(row, now)) }
  }

  /** 撤销：幂等（已撤销不覆盖时间） */
  async revoke(identity: ShareIdentity, id: string): Promise<SuccessResultModel> {
    const row = await this.repo.findById(id)
    if (!row) throw new ShareLinkInvalidError()
    if (!identity.adminId && row.createdBy && row.createdBy !== identity.userId) {
      throw new ShareForbiddenError()
    }
    await this.repo.revoke(row.id)
    return { success: true }
  }

  /** 页面元信息（公开）：不含 key / 文件 id / 任何 URL */
  async meta(input: ShareTokenDto): Promise<ShareMetaModel> {
    const { row, file } = await this.loadActive(input.token)

    // 计数失败不影响访问；内容接口有 Range 会多发请求，所以只在这里计数
    void this.repo.touchViewed(row.id).catch(() => undefined)

    const { kind, officeKind } = resolvePreviewKind({
      filename: file.filename,
      mediaType: file.mediaType,
    })
    return {
      filename: file.filename,
      mediaType: file.mediaType,
      previewKind: kind,
      officeKind,
      bytes: file.bytes,
      expiresAt: row.expiresAt?.getTime() ?? null,
    }
  }

  /** 换预签名 URL（内部）：只给 Next 的 content 路由调用 */
  async resolve(input: ShareTokenDto, internalSecret?: string): Promise<ShareResolveModel> {
    this.assertInternal(internalSecret)

    const { file } = await this.loadActive(input.token)
    const { url } = await this.storage.getDownloadUrl({
      key: file.key,
      expiresIn: RESOLVE_URL_TTL_SECONDS,
    })
    return {
      url,
      filename: file.filename,
      mediaType: file.mediaType,
      bytes: file.bytes,
    }
  }

  /** 校验 token 并取到可用的文件行；任何失败都折叠成同一个错误 */
  private async loadActive(token: string): Promise<{ row: FileShareEntity; file: AiFileEntity }> {
    const row = await this.repo.findByTokenHash(hashShareToken(token))
    if (!row || shareState(row) !== 'active') throw new ShareLinkInvalidError()

    const file = await this.repo.findFile(row.fileId)
    if (!file) throw new ShareLinkInvalidError()
    return { row, file }
  }

  /** 管理员不限；前台用户只能动自己上传 / 提交的文件 */
  private assertCanShare(identity: ShareIdentity, file: AiFileEntity): void {
    if (identity.adminId) return
    if (!identity.userId) return // 鉴权关闭：无身份概念，按管理员姿态
    if (!file.userId || file.userId !== identity.userId) throw new ShareForbiddenError()
  }

  /** 内部密钥：定长比较；未配置 = 不开放（同样 404，不暴露端点存在） */
  private assertInternal(secret?: string): void {
    const expected = this.settings.internalSecret
    if (!expected) throw new ShareLinkInvalidError()

    const given = Buffer.from(secret ?? '')
    const want = Buffer.from(expected)
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new ShareLinkInvalidError()
    }
  }

  private toItem(row: FileShareEntity, now: number): ShareItemModel {
    return {
      id: row.id,
      expiresAt: row.expiresAt?.getTime() ?? null,
      revokedAt: row.revokedAt?.getTime() ?? null,
      views: row.views,
      lastViewedAt: row.lastViewedAt?.getTime() ?? null,
      createdAt: row.createdAt.getTime(),
      state: shareState(row, now),
      // 历史列表不回 token：明文只在创建响应里出现一次（见设计 §4.3）
    }
  }
}
