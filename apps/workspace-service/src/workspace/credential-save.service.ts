import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import type { CredentialImportResponse } from '@repo/contracts'
import { WorkspaceRepository } from './workspace.repository.js'
import { importCredentialToMain } from './credential-main.client.js'
import { WorkspaceServiceConfig, type WorkspaceServiceConfigValue } from '../config/app-config.js'

/** 用户主动给出的凭据值（键名 = 模板字段 key） */
export interface CredentialSaveInput {
  provider: string
  /** 模板 key（同 provider 多模板时必须给，如 `lark-app`） */
  template?: string
  /** 凭据名（缺省由 main 用 provider 兜底） */
  name?: string
  values: Record<string, unknown>
}

/**
 * **保存用户主动给出的凭据**（与「从容器导入」互补的一条通道）。
 *
 * 为什么需要它：用户常在会话里直接贴出 App ID / Secret 让 agent 配环境，
 * 而 `credential-import` 的 D9 口径是「值不经过模型」——它只能读容器里已有的登录态。
 * 这条通道让模型把用户**明确给出**的值交给控制面加密入库，值只走内部 HTTP，
 * 不回显、不落日志、不进时间线。
 *
 * 归属判定与加密都在 main（`/internal/credentials/import`）；这里只做归属解析与转发。
 */
@Injectable()
export class WorkspaceCredentialSaveService {
  constructor(
    @Inject(WorkspaceRepository) private readonly repo: WorkspaceRepository,
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async save(
    workspaceId: string,
    input: CredentialSaveInput,
  ): Promise<CredentialImportResponse['credential']> {
    const context = await this.repo.findSetupContext(workspaceId)
    if (!context) throw new Error(`工作区不存在：${workspaceId}`)

    const credential = await importCredentialToMain(
      {
        mainUrl: this.config.mainUrl,
        token: this.config.mainToken ?? this.config.internalToken,
      },
      {
        ownerType: context.ownerType,
        ownerId: context.ownerId,
        provider: input.provider,
        ...(input.template ? { template: input.template } : {}),
        ...(input.name ? { name: input.name } : {}),
        values: input.values,
      },
    )
    // 只记元数据：值绝不进日志
    this.logger.log('credential.saved', {
      workspaceId,
      provider: credential.provider,
      name: credential.name,
      template: input.template ?? null,
    })
    return credential
  }
}
