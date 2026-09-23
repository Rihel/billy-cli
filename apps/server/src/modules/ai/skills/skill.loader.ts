import { Inject, Injectable, Optional } from '@nestjs/common'
import { createSkill, validateSkillContent, type InlineSkill } from '@mastra/core/skills'
import { AppLogger } from '@repo/kits'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { AgentSkill, AgentSkillMeta } from './skills.types.js'

/** 技能内容目录（与 loader 同级的 `catalog/`，dev 走 src、构建后走 dist，由 copy-assets 保证存在） */
const defaultCatalogDir = (): string => join(import.meta.dirname, 'catalog')

/** SKILL.md 文件名（Agent Skills 标准） */
const SKILL_FILE = 'SKILL.md'
/** 参考文件目录名（按需加载的长清单 / 模板） */
const REFERENCES_DIR = 'references'

/**
 * 技能目录的注入 token（可选）。
 *
 * 生产走默认目录；测试里注入临时目录即可（不需要为了可测性把 loader 的构造参数改成
 * 「先 new 再 set」那种可变状态）。
 */
export const SKILL_CATALOG_DIR = Symbol.for('SkillCatalogDir')

/**
 * 技能加载器（bean）：**把磁盘上的技能加载成 Agent 可用的技能对象**。
 *
 * 为什么需要一个 loader，而不是在 agent 定义里写死技能内容：
 * 1. **技能是内容资产**（Markdown，会越写越长、可能多人维护），放进 `.ts` 里既难写也难读；
 * 2. **加载即校验**：`validateSkillContent`（Mastra 的规则，不自己造）检查 frontmatter、
 *    name 与目录名一致、正文长度等；校验失败**在 bootstrap 期抛错**，不让坏技能进生产；
 * 3. **装配期可查**：`/agent/list` 能报出每个 agent 装了哪些技能，排查"模型没按技能回答"时
 *    第一眼就能确认技能到底加载上没有。
 *
 * 为什么不直接用 Mastra 的目录能力（`skills: ['./skills/xxx']` 传路径）：
 * 那样无法在启动期校验、也无法把技能清单暴露给接口（`WorkspaceSkills` 不在
 * `@mastra/core` 的公开子路径导出里）。故自己扫目录（约 40 行）+ 复用 Mastra 的校验与
 * `createSkill`（技能运行时行为完全交给 Mastra）。
 *
 * 加载结果做进程内缓存：技能在运行期不变（改技能要重启，这是刻意的——
 * 提示词与技能属于"部署物"，不做热更新，避免线上行为与代码不一致）。
 */
@Injectable()
export class SkillLoader {
  private readonly catalogDir: string
  /** 首次加载的 promise（并发调用共享一次读盘；失败不缓存重试语义，直接向上抛） */
  private loading?: Promise<AgentSkill[]>

  constructor(
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Optional() @Inject(SKILL_CATALOG_DIR) catalogDir?: string,
  ) {
    this.catalogDir = catalogDir ?? defaultCatalogDir()
  }

  /** 全部技能画像（供接口展示与 agent 声明校验） */
  async list(): Promise<AgentSkillMeta[]> {
    const skills = await this.loadAll()
    return skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
    }))
  }

  /**
   * 按名取技能对象（装配 Agent 用）。
   *
   * 未知技能名**抛错**：agent 声明了不存在的技能属于装配错误，
   * 必须启动即失败，而不是让模型在缺技能的情况下"自由发挥"。
   */
  async resolve(names: readonly string[]): Promise<InlineSkill[]> {
    const skills = await this.loadAll()
    const byName = new Map(skills.map((skill) => [skill.name, skill]))
    return names.map((name) => {
      const skill = byName.get(name)
      if (!skill) {
        throw new Error(
          `agent 声明了不存在的技能: ${name}（已加载: ${[...byName.keys()].join(', ') || '无'}）`,
        )
      }
      return skill.skill
    })
  }

  /** 加载（首次读盘 + 校验，之后走缓存） */
  private loadAll(): Promise<AgentSkill[]> {
    this.loading ??= this.loadFromDisk()
    return this.loading
  }

  private async loadFromDisk(): Promise<AgentSkill[]> {
    if (!existsSync(this.catalogDir)) {
      // 没有技能不是错误：技能是可选能力，模板 clone 下来可以先不写技能
      this.logger.log('ai.skills.empty', { catalogDir: this.catalogDir })
      return []
    }

    const skillDirs = readdirSync(this.catalogDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    const skills = skillDirs.map((dirName) => this.loadSkill(dirName))
    this.logger.log('ai.skills.loaded', {
      count: skills.length,
      names: skills.map((skill) => skill.name),
    })
    return skills
  }

  /** 加载单个技能目录：SKILL.md 必须存在且通过 Mastra 的校验 */
  private loadSkill(dirName: string): AgentSkill {
    const skillPath = join(this.catalogDir, dirName)
    const skillFile = join(skillPath, SKILL_FILE)
    if (!existsSync(skillFile)) {
      throw new Error(`技能目录缺少 ${SKILL_FILE}: ${skillPath}`)
    }

    const content = readFileSync(skillFile, 'utf8')
    const validation = validateSkillContent({ content, directoryName: dirName })
    if (!validation.valid) {
      throw new Error(
        `技能 ${dirName} 校验失败（${skillFile}）：\n- ${validation.errors.join('\n- ')}`,
      )
    }
    for (const warning of validation.warnings) {
      // 警告不拦截启动，但必须出现在启动日志里（例如正文过长会影响上下文成本）
      this.logger.warn('ai.skills.warning', { skill: dirName, warning })
    }

    const metadata = validation.metadata ?? {}
    const name = typeof metadata.name === 'string' ? metadata.name : dirName
    const description = typeof metadata.description === 'string' ? metadata.description : ''
    const instructions = validation.instructions ?? ''
    const references = this.loadReferences(skillPath)

    return {
      name,
      description,
      instructions,
      path: skillPath,
      references,
      skill: createSkill({ name, description, instructions, references }),
    }
  }

  /** 读取 `references/` 下的全部文件（技能长内容按需加载，故这里是「打包进技能」而非注入提示词） */
  private loadReferences(skillPath: string): Record<string, string> {
    const referencesDir = join(skillPath, REFERENCES_DIR)
    if (!existsSync(referencesDir)) return {}

    const result: Record<string, string> = {}
    for (const file of walk(referencesDir)) {
      // 统一用 `/` 作为键，跨平台一致（Windows 下 path 用 `\`）
      const key = relative(referencesDir, file).split(sep).join('/')
      result[key] = readFileSync(file, 'utf8')
    }
    return result
  }
}

/** 递归列出目录下的全部文件（技能参考文件层级很浅，无需考虑软链与性能） */
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return statSync(full).isFile() ? [full] : []
  })
