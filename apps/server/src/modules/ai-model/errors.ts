import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

/**
 * AI 模型模块的错误类型（34xx 段，见设计文档 §4.8.6）。
 *
 * 约定：**HTTP 响应文案来自错误码字典的 label**（`app-exception.filter` 只查字典），
 * 所以这里的 `message` 主要给**日志与单测**看 —— 供应商原文、失败地址这类排障信息
 * 必须写进 `message`（以及 `ai_providers.last_sync_error`），否则线上无从查起。
 */

/** 供应商不存在（3401） */
export class ProviderNotFoundError extends AppError {
  readonly code = AppErrorCodes.ProviderNotFound

  constructor(readonly providerId: string) {
    super(`模型供应商不存在：${providerId}`)
  }
}

/** 模型不存在（3402；模型被禁用时也走这个码，说明见 `resolveForRuntime`） */
export class ModelNotFoundError extends AppError {
  readonly code = AppErrorCodes.ModelNotFound

  constructor(
    readonly modelId: string,
    message = `模型不存在：${modelId}`,
  ) {
    super(message)
  }
}

/**
 * 拉取模型明细失败（3403）。
 *
 * `endpoint` 记录**实际请求的地址**：`testProvider` 失败时要把它回给前端
 * （排障第一步就是确认"打到了哪"）。adapter 抛出时都会带上。
 */
export class ModelSyncFailedError extends AppError {
  readonly code = AppErrorCodes.ModelSyncFailed

  constructor(
    message: string,
    readonly endpoint = '',
  ) {
    super(message)
  }
}

/** 供应商已禁用（3404；禁用后不允许被选中，也不允许同步） */
export class ProviderDisabledError extends AppError {
  readonly code = AppErrorCodes.ProviderDisabled

  constructor(readonly providerId: string) {
    super(`模型供应商已禁用：${providerId}`)
  }
}

/**
 * 密钥加密口令不可用（3405）。
 *
 * 三种情形共用（都要求"明确报错、不静默"）：
 * - `AI_MODEL_ENCRYPTION_KEY` 与 `JWT_SECRET` 都没配 → 无法加密 / 解密；
 * - 密文解不开（口令变更 / 密文损坏）→ 绝不返回空串；
 * - 供应商压根没配密钥，却被运行时选中。
 */
export class ProviderKeyUnavailableError extends AppError {
  readonly code = AppErrorCodes.ProviderKeyUnavailable

  constructor(
    message = '未配置密钥加密口令（AI_MODEL_ENCRYPTION_KEY 与 JWT_SECRET 都为空），无法加解密供应商密钥',
  ) {
    super(message)
  }
}

/** 库里一条"可用模型"都没有（3406）：运行时唯一的"没得选"出口，绝不回落到环境变量 */
export class ModelNotConfiguredError extends AppError {
  readonly code = AppErrorCodes.ModelNotConfigured

  constructor(
    message = '还没有配置可用的模型，请先在后台「模型管理」添加供应商与模型',
  ) {
    super(message)
  }
}

/**
 * slug 不可用（4001，参数问题）。
 *
 * 复用通用的 `InvalidInput`：字典里没有为"slug 生成失败 / 被占用"单设 34xx 码，
 * 而它确实是入参问题（要求调用方手填或换一个）。
 */
export class ProviderSlugInvalidError extends AppError {
  readonly code = AppErrorCodes.InvalidInput

  constructor(
    message = '无法根据名称生成 slug（需要至少一个 ASCII 小写字母或数字），请手动指定 slug',
  ) {
    super(message)
  }
}

/**
 * 供应商展示名已被占用（4001，参数问题）。
 *
 * 复用 `InvalidInput`：字典里没有为"名称重复"单设 34xx 码。存在的意义是**在服务层拦住**，
 * 不让 PostgreSQL 的 23505 冒到 HTTP 边界变成"系统错误"（软删感知的唯一索引在库里，
 * 但用户需要可读的原因）。
 */
export class ProviderNameTakenError extends AppError {
  readonly code = AppErrorCodes.InvalidInput

  constructor(
    readonly name: string,
    message = `供应商名称已存在：${name}`,
  ) {
    super(message)
  }
}

/** 同一供应商下 modelKey 已存在（4001，参数问题，避免落到唯一索引的裸数据库错误） */
export class ModelKeyTakenError extends AppError {
  readonly code = AppErrorCodes.InvalidInput

  constructor(
    readonly providerId: string,
    readonly modelKey: string,
  ) {
    super(`该供应商下已存在模型：${modelKey}`)
  }
}
