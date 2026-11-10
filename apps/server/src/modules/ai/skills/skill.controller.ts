import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  AiSkillCreateSchema,
  AiSkillFileReadSchema,
  AiSkillFileRemoveSchema,
  AiSkillFileSaveSchema,
  AiSkillImportPreviewSchema,
  AiSkillImportSchema,
  AiSkillKeySchema,
  AiSkillListSchema,
  AiSkillUpdateSchema,
} from '@repo/shared'
import type {
  AiSkillCreateDto,
  AiSkillFileReadDto,
  AiSkillFileRemoveDto,
  AiSkillFileSaveDto,
  AiSkillImportDto,
  AiSkillImportPreviewDto,
  AiSkillKeyDto,
  AiSkillListDto,
  AiSkillUpdateDto,
} from '@repo/shared'
import { AdminAuthGuard } from '../../admin/admin-auth.guard.js'
import { SkillLibraryService } from './skill.service.js'

/**
 * 技能库路由（`/ai-skill/*`，**全部后台管理员鉴权** + 全部 POST）。
 *
 * 只做 HTTP 边界：入参经 `@Body({ schema })` 校验后交给 service，业务逻辑与落盘全在 service。
 * 错误码：3412 不存在 / 3413 内容不合法 / 3414 重名 / 3415 文件不合法 /
 * 3416 导入失败 / 3417 版本冲突 / 3418 落盘失败。
 */
@Controller('ai-skill')
@UseGuards(AdminAuthGuard)
export class SkillController {
  constructor(@Inject(SkillLibraryService) private readonly skills: SkillLibraryService) {}

  /** 列表（分页 + 关键字 / 启用 / 来源筛选） */
  @Post('list')
  @HttpCode(200)
  list(@Body({ schema: AiSkillListSchema }) input: AiSkillListDto) {
    return this.skills.list(input)
  }

  /** 详情（元信息 + 文件清单，不含正文） */
  @Post('detail')
  @HttpCode(200)
  detail(@Body({ schema: AiSkillKeySchema }) input: AiSkillKeyDto) {
    return this.skills.detail(input.skillKey)
  }

  /** 新建（建完默认启用，落盘后立即对模型可见） */
  @Post('create')
  @HttpCode(200)
  create(@Body({ schema: AiSkillCreateSchema }) input: AiSkillCreateDto) {
    return this.skills.create(input)
  }

  /** 更新元信息 / 开关（内容变化时带 `expectedVersion` 做乐观锁） */
  @Post('update')
  @HttpCode(200)
  update(@Body({ schema: AiSkillUpdateSchema }) input: AiSkillUpdateDto) {
    return this.skills.update(input)
  }

  /** 删除（软删 + 删落盘目录） */
  @Post('remove')
  @HttpCode(200)
  remove(@Body({ schema: AiSkillKeySchema }) input: AiSkillKeyDto) {
    return this.skills.remove(input.skillKey)
  }

  /** 读单个文件正文 */
  @Post('file/read')
  @HttpCode(200)
  readFile(@Body({ schema: AiSkillFileReadSchema }) input: AiSkillFileReadDto) {
    return this.skills.readFile(input.skillKey, input.path)
  }

  /** 写单个文件（新建或覆盖；带 `expectedVersion` 做乐观锁） */
  @Post('file/save')
  @HttpCode(200)
  saveFile(@Body({ schema: AiSkillFileSaveSchema }) input: AiSkillFileSaveDto) {
    return this.skills.saveFile(input)
  }

  /** 删单个文件（`SKILL.md` 不允许删） */
  @Post('file/remove')
  @HttpCode(200)
  removeFile(@Body({ schema: AiSkillFileRemoveSchema }) input: AiSkillFileRemoveDto) {
    return this.skills.removeFile(input)
  }

  /** 导入预览：这个链接里有哪些技能、哪些已存在 */
  @Post('import/preview')
  @HttpCode(200)
  previewImport(@Body({ schema: AiSkillImportPreviewSchema }) input: AiSkillImportPreviewDto) {
    return this.skills.preview(input)
  }

  /** 从链接导入（skills.sh / GitHub / 直接 Markdown 链接） */
  @Post('import')
  @HttpCode(200)
  importSkills(@Body({ schema: AiSkillImportSchema }) input: AiSkillImportDto) {
    return this.skills.import(input)
  }
}
