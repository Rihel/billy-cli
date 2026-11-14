import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * **技能文件**（`ai_skill_files`，设计 `docs/design/ai-skill-library.md`）。
 *
 * 一行 = 技能目录里的一个文本文件：`SKILL.md` / `references/*.md` / `scripts/*.py` …
 *
 * 三条口径：
 * - **路径是相对技能目录的**（与 Mastra 的 `skill_read` 口径一致，如 `references/guide.md`）；
 *   绝对路径、`..`、反斜杠在入参层已被拒绝，落盘前还会再归一化一次（纵深防御）；
 * - **硬删**（不用软删）：文件没有独立审计价值，技能的删除/版本由 `ai_skills` 承担；
 *   软删还会让 `(skill_id, path)` 唯一键在"删掉再建同名文件"时冲突；
 * - **`sha256` 用于落盘幂等**：内容没变就不重写，避免无谓改 mtime。
 */
@Entity('ai_skill_files')
@Index('uk_skill_file', ['skillId', 'path'], { unique: true })
@Index('idx_skill_file_skill', ['skillId'])
export class AiSkillFileEntity extends BaseEntity {
  /** 所属技能（逻辑引用，无物理外键；跟随技能的软删一起失效） */
  @Column({ name: 'skill_id', type: 'varchar', length: 20 })
  skillId!: string

  /** 相对技能目录的路径（`SKILL.md` / `references/a.md` / `scripts/a.py`） */
  @Column({ name: 'path', type: 'varchar', length: 255 })
  path!: string

  /** 文本内容（二进制不进库；大小在 service 层按字符数限制） */
  @Column({ name: 'content', type: 'text' })
  content!: string

  /** UTF-8 字节数（列表展示"多大"，也用于总量限额） */
  @Column({ name: 'size', type: 'int', default: 0 })
  size = 0

  /** 内容的 sha256（落盘幂等用） */
  @Column({ name: 'sha256', type: 'varchar', length: 64, default: '' })
  sha256 = ''
}
