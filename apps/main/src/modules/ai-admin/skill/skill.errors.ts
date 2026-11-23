import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

/**
 * 技能管理模块的业务错误。
 *
 * 错误码沿用 `@repo/shared` 里既有的 3412–3417 段（agent-runtime 时代定下的语义，
 * 前端与 SDK 已经按这些码处理），保证迁移到 main 后调用方不需要改错误分支。
 */

/** 技能不存在（或已删除） */
export class SkillNotFoundError extends AppError {
  readonly code = AppErrorCodes.SkillNotFound
  constructor(readonly skillKey: string) {
    super(`技能不存在：${skillKey}`)
  }
}

/** 技能内容不合法（frontmatter / 名字 / description 超长等） */
export class SkillInvalidError extends AppError {
  readonly code = AppErrorCodes.SkillInvalid
  constructor(readonly details: readonly string[]) {
    super(`技能内容不合法：${details.join('；')}`)
  }
}

/** 技能名已被占用（软删感知：删掉之后可以重建同名技能） */
export class SkillKeyConflictError extends AppError {
  readonly code = AppErrorCodes.SkillKeyConflict
  constructor(readonly skillKey: string) {
    super(`技能名已被占用：${skillKey}`)
  }
}

/** 技能文件不合法：路径白名单、大小上限、`SKILL.md` 不允许删 */
export class SkillFileInvalidError extends AppError {
  readonly code = AppErrorCodes.SkillFileInvalid
  constructor(readonly reason: string) {
    super(`技能文件不合法：${reason}`)
  }
}

/** 从链接导入失败（链接不合法 / 下载失败 / 没有技能 / 读取越界） */
export class SkillImportFailedError extends AppError {
  readonly code = AppErrorCodes.SkillImportFailed
  constructor(readonly reason: string) {
    // detail 才是用户 / 模型需要的那句原因（匿名限额、404、超时、没有 SKILL.md）；
    // 只给字典 label 时界面永远只有一句「技能导入失败」
    super(`技能导入失败：${reason}`, reason)
  }
}

/** 乐观锁冲突：页面拿的是旧版本，别人已经改过 */
export class SkillVersionConflictError extends AppError {
  readonly code = AppErrorCodes.SkillVersionConflict
  constructor(readonly skillKey: string) {
    super(`技能已被其他人修改，请刷新后重试：${skillKey}`)
  }
}

/** 个人技能配额（§6.7.5：50 个 / 单文件 1 MB，避免技能目录膨胀占用上下文） */
export class SkillQuotaExceededError extends AppError {
  readonly code = AppErrorCodes.SkillQuotaExceeded
  constructor(readonly limit: number) {
    super(`Personal skill quota exceeded: ${limit}`)
  }
}
