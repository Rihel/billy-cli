import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

/** 技能不存在（或已删除） */
export class SkillNotFoundError extends AppError {
  readonly code = AppErrorCodes.SkillNotFound
  constructor(readonly skillKey: string) {
    super(`技能不存在：${skillKey}`)
  }
}

/**
 * 技能内容不合法（frontmatter / 名字 / description 超长 / 正文警告以外的错误）。
 *
 * 错误信息带上 Mastra 的原始结论：校验规则在它那边，抄一份到这里只会漂移。
 */
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
    super(`技能导入失败：${reason}`)
  }
}

/** 乐观锁冲突：页面拿的是旧版本，别人已经改过 */
export class SkillVersionConflictError extends AppError {
  readonly code = AppErrorCodes.SkillVersionConflict
  constructor(readonly skillKey: string) {
    super(`技能已被其他人修改，请刷新后重试：${skillKey}`)
  }
}

/** 落盘失败（DB 已提交）：下一次启动 `syncAll` 会自愈，但这一次要如实报错 */
export class SkillMaterializeFailedError extends AppError {
  readonly code = AppErrorCodes.SkillMaterializeFailed
  constructor(readonly reason: string) {
    super(`技能已入库，但写入技能目录失败：${reason}`)
  }
}
