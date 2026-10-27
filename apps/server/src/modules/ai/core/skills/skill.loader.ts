import { Inject, Injectable, Optional } from '@nestjs/common'
import { validateSkillContent } from '@mastra/core/skills'
import { AppLogger } from '@repo/kits'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { ALL_SKILLS, type AgentSkillMeta, type SkillRef } from './skills.types.js'

/** 随部署打包的技能目录（与 loader 同级的 `catalog/`，dev 走 src、构建后走 dist） */
const defaultCatalogDir = (): string => join(import.meta.dirname, 'catalog')

/** SKILL.md 文件名（Agent Skills 标准） */
const SKILL_FILE = 'SKILL.md'

/**
 * 额外技能目录的注入 token（由 `ai.module` 从 `AgentConfig.skillsDirs` 供给）。
 *
 * 用 token 而不是让 loader 自己读配置：loader 是纯"扫目录"的能力，
 * 配置从哪来（env / 后台 / 测试注入）不归它管。
 */
export const SKILL_DIRS = Symbol.for('SkillDirs')

/**
 * 技能加载器（bean）：**发现 / 校验 / 授权**。
 *
 * 它**不读正文进内存**，只把「技能目录的绝对路径」交给 Mastra：
 * `Agent({ skills: ['/…/catalog/<name>', '/Users/xx/.agents/skills/<name>'] })`
 * 之后由 Mastra 的 `LocalSkillSource` + `WorkspaceSkills` 负责清单注入、正文与 `references/` 的按需读盘
 * （`skill` / `skill_search` / `skill_read` 工具）。这样：
 * 1. 技能库可以是几十个、参考文件上百个，启动时不占内存、不拖慢启动；
 * 2. 技能改了不需要重启（Mastra 按需读盘 / 带冷却的 refresh）；
 * 3. 我们仍然拿到**启动期校验**与**可查的清单**（`/agent/list`）——这是不用 Mastra 目录能力的原顾虑，现已补上。
 *
 * 目录来源（按顺序，**前面的优先级高**，重名后者跳过）：
 * 1. `core/skills/catalog/` —— 随部署打包，**校验不通过直接启动失败**（我们自己的资产，坏了就是发版事故）；
 * 2. `AI_SKILLS_DIRS` 配置的目录 —— 用户自带技能库（默认 `~/.agents/skills`），
 *    **坏一个只跳过并记错误日志**，不拿别人的技能库绑架整个服务启动。
 *
 * 扫描结果进程内缓存：技能属于"部署物"，增删要重启（Mastra 那份内容侧仍会自刷新，不影响这份名单）。
 */
@Injectable()
export class SkillLoader {
  private readonly roots: readonly string[]
  /** 首次加载的 promise（并发调用共享一次读盘；失败不缓存，直接向上抛） */
  private loading?: Promise<SkillRef[]>
  private readonly catalogRoot: string
  private readonly extraRoots: readonly string[]

  constructor(
    @Inject(AppLogger) private readonly logger: AppLogger,
    /**
     * 额外技能目录（配置默认 `~/.agents/skills`，见 `AgentConfig.skillsDirs`）。
     *
     * 不传 = 只装随部署打包的 `catalog/`：测试与"零配置"场景要的是确定性，
     * 不能因为跑测试那台机器上恰好有个 `~/.agents/skills` 就换一套行为。
     */
    @Optional() @Inject(SKILL_DIRS) extraDirs: readonly string[] = [],
  ) {
    this.catalogRoot = defaultCatalogDir()
    this.extraRoots = normalizeDirs(extraDirs)
    this.roots = [this.catalogRoot, ...this.extraRoots]
  }

  /** 全部技能的画像（供接口展示与 agent 声明校验） */
  async list(): Promise<AgentSkillMeta[]> {
    const skills = await this.loadAll()
    return skills.map((skill) => ({ name: skill.name, description: skill.description }))
  }

  /** 全部技能名（装配期展开 `ALL_SKILLS` 用） */
  async names(): Promise<string[]> {
    const skills = await this.loadAll()
    return skills.map((skill) => skill.name)
  }

  /**
   * 按名取技能（装配 Agent 用）：只解析**路径**，正文由 Mastra 按需读。
   *
   * 未知技能名**抛错**：agent 声明了不存在的技能属于装配错误，
   * 必须启动即失败，而不是让模型在缺技能的情况下"自由发挥"。
   * `ALL_SKILLS` 表示"全部已加载技能"。
   */
  async resolve(names: readonly string[]): Promise<SkillRef[]> {
    const skills = await this.loadAll()
    if (names.includes(ALL_SKILLS)) return [...skills]

    const byName = new Map(skills.map((skill) => [skill.name, skill]))
    return names.map((name) => {
      const skill = byName.get(name)
      if (!skill) {
        throw new Error(
          `agent 声明了不存在的技能: ${name}（已加载: ${[...byName.keys()].join(', ') || '无'}）`,
        )
      }
      return skill
    })
  }

  /** 加载（首次读盘 + 校验，之后走缓存） */
  private loadAll(): Promise<SkillRef[]> {
    this.loading ??= this.loadFromDisk()
    return this.loading
  }

  private async loadFromDisk(): Promise<SkillRef[]> {
    const found = new Map<string, SkillRef>()

    this.roots.forEach((root, index) => {
      // 第 0 个是随部署打包的 catalog：我们自己的东西，坏了必须拦在启动；
      // 其余是用户自带技能库：坏一个跳过即可（否则别人的一个 typo 能让服务起不来）
      const strict = index === 0
      if (!existsSync(root)) {
        this.logger.log('ai.skills.dir_missing', { dir: root, strict })
        return
      }

      for (const dirName of readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()) {
        const skill = this.readSkill(root, dirName, strict)
        if (!skill) continue
        if (found.has(skill.name)) {
          // 重名：先扫到的赢（catalog > 前面的额外目录 > 后面的），后者明确记一条，省得排查"我改了怎么没生效"
          this.logger.warn('ai.skills.duplicate', {
            skill: skill.name,
            kept: found.get(skill.name)!.path,
            ignored: skill.path,
          })
          continue
        }
        found.set(skill.name, skill)
      }
    })

    const skills = [...found.values()]
    this.logger.log('ai.skills.loaded', {
      count: skills.length,
      roots: this.roots,
      strictRoot: this.catalogRoot,
      names: skills.map((skill) => skill.name),
    })
    return skills
  }

  /**
   * 读一个技能目录的 frontmatter 并校验。
   *
   * 只读 `SKILL.md`（几 KB）：正文与 `references/` 交给 Mastra 按需读，
   * 这里要的只是"这技能叫什么、什么时候用、能不能用"。
   *
   * 返回 `undefined` = 这个目录不是技能 / 校验没过且允许跳过。
   */
  private readSkill(root: string, dirName: string, strict: boolean): SkillRef | undefined {
    const skillPath = join(root, dirName)
    const skillFile = join(skillPath, SKILL_FILE)
    if (!existsSync(skillFile)) {
      // 子目录里没有 SKILL.md：catalog 里是我们的疏漏（按装配错误处理），外部技能库里可能是随手放的文档
      if (strict) throw new Error(`技能目录缺少 ${SKILL_FILE}: ${skillPath}`)
      this.logger.warn('ai.skills.skipped', { path: skillPath, reason: `缺少 ${SKILL_FILE}` })
      return undefined
    }

    const content = readFileSync(skillFile, 'utf8')
    const validation = validateSkillContent({ content, directoryName: dirName })
    if (!validation.valid) {
      const reason = validation.errors.join('; ')
      // 外部技能库的"坏技能"很常见（比如 description 超过 1024 字符），跳过并留痕即可；
      // 忽略它比让整个服务起不来更符合"用户的技能库不该绑架部署"。
      if (strict) throw new Error(`技能 ${dirName} 校验失败（${skillFile}）：\n- ${reason}`)
      this.logger.error('ai.skills.invalid', { path: skillPath, reason })
      return undefined
    }
    for (const warning of validation.warnings) {
      // 警告不拦截启动，但必须出现在启动日志里（例如正文过长会影响上下文成本）
      this.logger.warn('ai.skills.warning', { skill: dirName, warning })
    }

    const metadata = validation.metadata ?? {}
    return {
      name: typeof metadata.name === 'string' ? metadata.name : dirName,
      description: typeof metadata.description === 'string' ? metadata.description : '',
      path: skillPath,
    }
  }
}

/** 目录归一：展开 `~`、转绝对路径、去重（同一个目录配两遍不该扫两遍） */
const normalizeDirs = (dirs: readonly string[]): string[] => {
  const result: string[] = []
  for (const dir of dirs) {
    const trimmed = dir.trim()
    if (!trimmed) continue
    const expanded =
      trimmed === '~'
        ? homedir()
        : trimmed.startsWith('~/')
          ? join(homedir(), trimmed.slice(2))
          : trimmed
    const absolute = isAbsolute(expanded) ? expanded : resolvePath(process.cwd(), expanded)
    if (!result.includes(absolute)) result.push(absolute)
  }
  return result
}
