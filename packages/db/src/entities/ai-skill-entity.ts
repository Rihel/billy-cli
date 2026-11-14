import { AuditEntity } from '@repo/kits'
import { SkillSource } from '@repo/shared'
import { Column, Entity, Index } from 'typeorm'

/**
 * **AI 技能**（配置 / 资产类数据，设计 `docs/design/ai-skill-library.md`）。
 *
 * 一行 = 一个 Agent Skills 标准的技能。**DB 是事实源**：正文与参考文件存在 `ai_skill_files`，
 * 保存时落盘成 `<skillsLibraryDir>/<skill_key>/`，Mastra 只认那个目录（正文与 `references/`
 * 由它按需读盘）。
 *
 * 六条口径：
 * - **`skill_key` 就是目录名**、创建后不可改（改名 = 新建 + 删除），历史运行按名字引用它；
 * - **`enabled=false` 要同时删掉落盘目录**：模型的清单与 `skill_read` 都以目录为界，
 *   只改库不删目录等于没停用；
 * - **`description` 是 frontmatter 的 description**（模型判断"什么时候用"），
 *   其余 YAML 键收在 `frontmatter`，渲染 `SKILL.md` 时拼回去；
 * - **正文不进列表**：列表只读本表，详情按需查文件（大文件不拖慢列表）；
 * - **`version` 每次写 +1**：页面保存带 `expectedVersion`，不匹配就 409，防两人互相覆盖；
 * - **`origin_url` 只对导入来源有意义**：记录"从哪个链接装来的"，便于重装与追溯。
 */
@Entity('ai_skills')
// 软删感知的唯一键（照 `ai_tools` / `ai_models` 的口径：删掉后可重建同一个 key）
@Index('uk_skill_key', ['skillKey'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
@Index('idx_skill_enabled', ['enabled'])
@Index('idx_skill_source', ['source'])
export class AiSkillEntity extends AuditEntity {
  /** 技能名（= 落盘目录名；`SKILL.md` 的 frontmatter `name` 与它一致） */
  @Column({ name: 'skill_key', type: 'varchar', length: 64 })
  skillKey!: string

  /** 人读标题（列表展示；省略时前端用 skillKey） */
  @Column({ name: 'title', type: 'varchar', length: 128, default: '' })
  title = ''

  /** frontmatter 的 description：什么时候用这个技能（≤1024，Mastra 硬校验） */
  @Column({ name: 'description', type: 'text' })
  description!: string

  /** 其余 frontmatter 键（license / compatibility / metadata / allowed-tools …） */
  @Column({ name: 'frontmatter', type: 'jsonb', default: () => "'{}'" })
  frontmatter: Record<string, unknown> = {}

  /** 总开关：停用即从落盘目录移除，模型看不到 */
  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled = true

  /** 来源：见 `SkillSource` 字典 */
  @Column({
    name: 'source',
    type: 'varchar',
    length: 16,
    default: SkillSource._source.Online.value,
  })
  source: string = SkillSource._source.Online.value

  /** 导入来源链接（`source='import'` 时保留，便于追溯 / 重装） */
  @Column({ name: 'origin_url', type: 'varchar', length: 1024, nullable: true })
  originUrl: string | null = null

  /** 内容版本：每次写 +1（乐观锁与审计用） */
  @Column({ name: 'version', type: 'int', default: 1 })
  version = 1

  /** 文件数（含 SKILL.md；冗余列，列表展示与限额校验都直接读它） */
  @Column({ name: 'file_count', type: 'int', default: 1 })
  fileCount = 1

  /** 全部文件内容的 sha256（落盘幂等的判据：没变就不重写） */
  @Column({ name: 'content_hash', type: 'varchar', length: 64, nullable: true })
  contentHash: string | null = null

  /** 最后一次成功落盘的时间（落盘失败时保留旧值，便于看出"库改了但盘没跟上"） */
  @Column({ name: 'last_materialized_at', type: 'timestamp', precision: 3, nullable: true })
  lastMaterializedAt: Date | null = null

  /** 最后一次通过 Mastra 校验的时间 */
  @Column({ name: 'last_validated_at', type: 'timestamp', precision: 3, nullable: true })
  lastValidatedAt: Date | null = null

  /** 校验警告（不拦保存；例如正文过长会占上下文） */
  @Column({ name: 'warnings', type: 'jsonb', default: () => "'[]'" })
  warnings: string[] = []
}
