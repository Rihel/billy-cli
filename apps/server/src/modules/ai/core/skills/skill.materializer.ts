import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { AppLogger } from '@repo/kits'
import { normalizeSkillKey, normalizeSkillsRoot, resolveSkillFilePath, skillDirOf } from './skill.paths.js'

/**
 * 技能落盘器：把库里的技能写成 Mastra 能读的目录（设计 `docs/design/ai-skill-library.md` §2.2）。
 *
 * 为什么需要这一层：Mastra 的 `LocalSkillSource` **只认磁盘目录**，正文与 `references/`
 * 都是按需读盘；而在线编辑 / 启停 / 导入要的是"库"（DB）。于是 DB 是事实源，
 * 这里负责把它投影成目录。
 *
 * 三条约束：
 * - **目录整体归我们管**：`sync` 会删掉本次不在集合里的旧文件、`pruneUnknown` 会清掉
 *   库里不存在的技能目录 —— 手工往技能库根目录里塞东西会被清掉（外部技能库请配 `AGENT_SKILLS_DIRS`）；
 * - **路径必须过白名单**（`skill.paths.ts`），落盘前再 resolve 一次校验不越界；
 * - **幂等**：内容没变就不重写，避免无谓改 mtime（Mastra 的内容缓存按 mtime 判断）。
 *
 * 进程内按技能串行：同一技能的两次保存并发时，后一次一定在前一次之后落盘（否则可能写出半个目录）。
 * 多实例部署时每个实例各写自己的本地目录，别的实例要等下次启动 `syncAll` 才看到新技能 ——
 * 这与当前 AI 运行期"记忆 / 流在进程内"的限制是同一类，不在这一层假装解决。
 */
export class SkillMaterializer {
  private readonly root: string
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(
    private readonly logger: AppLogger,
    root: string,
  ) {
    this.root = normalizeSkillsRoot(root)
  }

  /** 技能库根目录（交给 `SkillLoader` 当扫描根） */
  get rootPath(): string {
    return this.root
  }

  /**
   * 启动时全量同步：把已启用的技能全部写一遍，再清掉库里不存在的目录。
   *
   * 为什么启动要全量：落盘失败（进程被杀 / 磁盘满）时 DB 已经提交，重启是自愈点；
   * 同时把"上次停用后删目录失败"的残留清掉。
   */
  async syncAll(skills: readonly MaterializedSkill[]): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const known = new Set(skills.map((skill) => skill.skillKey))
    await this.pruneUnknown(known)
    for (const skill of skills) {
      await this.sync(skill)
    }
    this.logger.log('ai.skills.materialized', { root: this.root, count: skills.length })
  }

  /** 写一个技能（全量覆盖式：多余的旧文件会被删掉） */
  async sync(skill: MaterializedSkill): Promise<void> {
    await this.withKey(skill.skillKey, async () => {
      const dir = skillDirOf(this.root, skill.skillKey)
      await mkdir(dir, { recursive: true })

      const expected = new Set(skill.files.map((file) => file.path))
      for (const file of skill.files) {
        const target = resolveSkillFilePath(this.root, skill.skillKey, file.path)
        await mkdir(dirname(target), { recursive: true })
        const existing = await readFile(target, 'utf8').catch(() => null)
        if (existing !== file.content) await writeFile(target, file.content, 'utf8')
      }
      await this.pruneStale(dir, dir, expected)
    })
  }

  /** 删一个技能的目录（停用 / 删除时调用；目录不在也不报错） */
  async remove(skillKey: string): Promise<void> {
    const key = normalizeSkillKey(skillKey)
    await this.withKey(key, async () => {
      await rm(skillDirOf(this.root, key), { recursive: true, force: true })
    })
  }

  /** 清掉库里已经不存在的技能目录（只处理根目录下的一级目录） */
  private async pruneUnknown(known: ReadonlySet<string>): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // 以 `.` 开头的是临时目录 / 约定目录，不动
      if (entry.name.startsWith('.')) continue
      if (known.has(entry.name)) continue
      await rm(join(this.root, entry.name), { recursive: true, force: true })
      this.logger.warn('ai.skills.materialize_orphan_removed', { dir: join(this.root, entry.name) })
    }
  }

  /** 删掉目录里不在集合中的文件，并清理空目录 */
  private async pruneStale(dir: string, base: string, expected: ReadonlySet<string>): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.pruneStale(absolute, base, expected)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = relative(base, absolute).split('\\').join('/')
      if (expected.has(relativePath)) continue
      await rm(absolute, { force: true })
    }
    // 空目录不留在盘上（Mastra 会把它当成空目录名）
    if (dir !== base) {
      const left = await readdir(dir).catch(() => [])
      if (left.length === 0) await rm(dir, { recursive: true, force: true })
    }
  }

  /** 同一技能的写操作串行（不同技能并行） */
  private async withKey<T>(skillKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(skillKey) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    this.chains.set(skillKey, next)
    try {
      return await next
    } finally {
      if (this.chains.get(skillKey) === next) this.chains.delete(skillKey)
    }
  }
}

/** 落盘一个技能所需的最小数据（service 从库里的行拼出来） */
export interface MaterializedSkill {
  skillKey: string
  files: readonly { path: string; content: string }[]
}
