import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { shellQuote } from './exec-env.js'
import {
  credentialVersionOf,
  type WorkspaceSetupFile,
  type WorkspaceSetupPackage,
  type WorkspaceSetupReport,
} from '@repo/shared'
import type { CredentialInjectRule } from '@repo/shared'
import type { CredentialResolvedItem } from '@repo/contracts'
import { WorkspaceRepository } from './workspace.repository.js'
import { WorkspaceCredentialClient } from './credential.client.js'
import {
  installCommandOf,
  mergeSetupPackages,
  renderInjectRules,
  setupHashOf,
} from './setup-pure.js'
import type { SetupShell } from './setup-shell.js'
import { WorkspaceServiceConfig, type WorkspaceServiceConfigValue } from '../config/app-config.js'

/** 初始化总预算（§6.3）：超时项标记 timeout，工作区仍可用 */
const SETUP_BUDGET_MS = 5 * 60 * 1000
/** 单次安装的上限（90 秒是"首条命令可接受等待"的预算口径，单包给到 3 分钟） */
const INSTALL_TIMEOUT_MS = 180_000
/** `verify` 是轻量检查（`xx --version`），给 20 秒足够 */
const VERIFY_TIMEOUT_MS = 20_000

interface ResolvedPlan {
  setupId: string
  hash: string
  packages: WorkspaceSetupPackage[]
  files: WorkspaceSetupFile[]
  env: Record<string, string>
  skills: { key: string; files: { path: string; content: string }[] }[]
  owner: { ownerType: 'user' | 'admin'; ownerId: string }
}

/**
 * **初始化阶段**（`docs/design/workspace-cli-credentials.md` §6.3）。
 *
 * 容器首次创建后、模型执行首条命令前，按固定顺序完成四件事：
 * ① 按清单安装并逐项 `verify` → ② 物化技能到 `.agents/` → ③ 落地凭据 → ④ 写版本文件。
 *
 * 四条约束：
 * - **幂等**：`.billy/setup/<setupId>@<hash>.done` 标记，重复 ensure 不重做安装与技能；
 * - **顺序固定**：凭据最后落地，因为它的写入路径依赖 ①② 的结果；
 * - **失败不阻断**：单项失败记入 `setup_report`，工作区仍可用（超时项标 `timeout`）；
 * - **凭据每次 ensure 都重新落地**：便宜、且能保证与库一致（版本比对在 P6 加）。
 */
@Injectable()
export class WorkspaceSetupService {
  constructor(
    @Inject(WorkspaceRepository) private readonly repo: WorkspaceRepository,
    @Inject(WorkspaceCredentialClient) private readonly credentials: WorkspaceCredentialClient,
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 执行初始化，返回需要注入后续命令的凭据环境变量 */
  async run(
    workspaceId: string,
    shell: SetupShell,
  ): Promise<{
    env: Record<string, string>
    report: WorkspaceSetupReport
    manifest: { provider: string; name: string; expiresAt: string | null }[]
    /** 凭据段是否**整体解析成功**（false = 暂态失败，调用方应当补偿重试） */
    resolved: boolean
  }> {
    const startedAt = Date.now()
    const plan = await this.planOf(workspaceId)
    const report: WorkspaceSetupReport = {
      setupId: plan.setupId,
      hash: plan.hash,
      durationMs: 0,
      packages: [],
      skills: [],
      credentials: [],
    }

    const marker = `.billy/setup/${plan.setupId}@${plan.hash}.done`
    const done = await shell.read(marker).catch(() => null)
    if (!done) {
      await this.installPackages(shell, plan.packages, report, startedAt)
      await this.materializeSkills(shell, plan.skills, report)
      await this.materializeFiles(shell, plan.files)
      await shell.write(marker, new Date().toISOString()).catch((error: unknown) =>
        this.logger.warn('workspace.setup.marker_failed', {
          workspaceId,
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
    } else {
      // 幂等命中：不重装、不重写技能（但凭据仍要刷新，见下）
      this.logger.info('workspace.setup.marked', { workspaceId, marker })
    }

    const {
      env: credentialEnv,
      manifest,
      resolved,
    } = await this.materializeCredentials(workspaceId, shell, plan, report)

    await shell
      .write(
        '.billy/setup.json',
        JSON.stringify(
          {
            setupId: plan.setupId,
            hash: plan.hash,
            credentialVersion: 0,
            generatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      )
      .catch(() => undefined)
    await shell
      .write('.billy/credentials.json', JSON.stringify({ version: 0, items: manifest }, null, 2))
      .catch(() => undefined)

    report.durationMs = Date.now() - startedAt
    if (report.durationMs > 90_000) {
      this.logger.warn('workspace.setup.slow', {
        workspaceId,
        durationMs: report.durationMs,
        packages: plan.packages.length,
      })
    }
    this.logger.info('workspace.setup.done', {
      workspaceId,
      setupId: plan.setupId,
      durationMs: report.durationMs,
      packages: report.packages.length,
      skills: report.skills.length,
      credentials: report.credentials.length,
    })
    return { env: { ...plan.env, ...credentialEnv }, report, manifest, resolved }
  }

  /**
   * **只同步凭据**（P6 推送通道用）：不装包、不重写技能，只重新解析并按注入规则落地。
   *
   * 调用方保证工作区**正在运行**（只查不起）：这里不 ensure、不拉起容器。
   */
  /**
   * **技能收敛**（§6.7.4）：写入可见技能、删除已不可见的 `.agents/<key>/`。
   *
   * 删除是必须项：不删的话，被撤销授权的用户仍能用 `file-read` 读到正文，授权形同虚设。
   * 调用方保证工作区正在运行（只查不起）。
   */
  async syncSkills(
    workspaceId: string,
    shell: SetupShell,
  ): Promise<{ written: string[]; removed: string[] }> {
    const context = await this.repo.findSetupContext(workspaceId)
    if (!context) throw new Error(`工作区不存在：${workspaceId}`)
    const skills = await this.repo.listVisibleSkills({
      ownerType: context.ownerType,
      ownerId: context.ownerId,
    })

    const listed = await shell.exec('ls -1 .agents 2>/dev/null || true', { timeoutMs: 15_000 })
    const existing = listed.ok
      ? listed.stdout
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean)
      : []
    const visible = new Set(skills.map((skill) => skill.key))

    const removed: string[] = []
    for (const key of existing) {
      if (visible.has(key) || !/^[A-Za-z0-9._-]+$/.test(key)) continue
      const result = await shell.exec(`rm -rf ${shellQuote(`.agents/${key}`)}`, {
        timeoutMs: 15_000,
      })
      if (result.ok) removed.push(key)
    }

    const report: WorkspaceSetupReport = {
      setupId: 'skills',
      hash: '',
      durationMs: 0,
      packages: [],
      skills: [],
      credentials: [],
    }
    await this.materializeSkills(shell, skills, report)
    this.logger.info('workspace.sync.skills', {
      workspaceId,
      visible: skills.length,
      removed: removed.length,
    })
    return { written: skills.map((skill) => skill.key), removed }
  }

  async syncCredentials(
    workspaceId: string,
    shell: SetupShell,
  ): Promise<{
    env: Record<string, string>
    version: string
    report: WorkspaceSetupReport
    manifest: { provider: string; name: string; expiresAt: string | null }[]
    /** 凭据段是否整体解析成功（false = 暂态失败，调用方应当补偿重试） */
    resolved: boolean
  }> {
    const plan = await this.planOf(workspaceId)
    const report: WorkspaceSetupReport = {
      setupId: plan.setupId,
      hash: plan.hash,
      durationMs: 0,
      packages: [],
      skills: [],
      credentials: [],
    }
    const { env, version, manifest, resolved } = await this.applyCredentials(
      workspaceId,
      shell,
      plan,
      report,
    )
    report.durationMs = 0
    this.logger.info('workspace.sync.credentials', {
      workspaceId,
      version,
      credentials: report.credentials.length,
      resolved,
    })
    return { env, version, report, manifest, resolved }
  }

  // ── 计划：清单 + 技能 + 归属 ────────────────────────────────

  private async planOf(workspaceId: string): Promise<ResolvedPlan> {
    const context = await this.repo.findSetupContext(workspaceId)
    if (!context) throw new Error(`工作区不存在：${workspaceId}`)

    const owner = { ownerType: context.ownerType, ownerId: context.ownerId }
    const setup = context.setupId
      ? await this.repo.findSetupById(context.setupId)
      : await this.repo.findDefaultSetup(owner)

    const packages = mergeSetupPackages(
      this.asPackages(setup?.packages),
      this.asPackages(context.setupExtra),
    )
    const skills = await this.repo.listVisibleSkills({
      ownerType: context.ownerType,
      ownerId: context.ownerId,
    })
    const hash = setupHashOf({
      setupId: setup?.id ?? 'default',
      packages,
      skills: skills.map((skill) => ({
        key: skill.key,
        contentHash: skill.files.map((file) => `${file.path}:${file.content}`).join('|'),
      })),
    })

    return {
      setupId: setup?.id ?? 'default',
      hash,
      packages,
      files: this.asFiles(setup?.files),
      env: this.asEnv(setup?.env),
      skills: skills.map((skill) => ({ key: skill.key, files: skill.files })),
      owner,
    }
  }

  // ── ① 安装 ────────────────────────────────────────────────

  private async installPackages(
    shell: SetupShell,
    packages: WorkspaceSetupPackage[],
    report: WorkspaceSetupReport,
    startedAt: number,
  ): Promise<void> {
    for (const pkg of packages) {
      if (Date.now() - startedAt > SETUP_BUDGET_MS) {
        report.packages.push({ spec: pkg.spec, outcome: 'timeout', message: '初始化总预算已用尽' })
        continue
      }
      // 已满足就不装：重建时命中依赖缓存的表现就是"verify 直接过"
      const verified = await shell
        .exec(pkg.verify, { timeoutMs: VERIFY_TIMEOUT_MS })
        .catch((error: unknown) => ({
          ok: false,
          code: -1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        }))
      if (verified.ok) {
        report.packages.push({ spec: pkg.spec, outcome: 'skipped' })
        continue
      }

      const installed = await shell
        .exec(installCommandOf(pkg), { timeoutMs: INSTALL_TIMEOUT_MS })
        .catch((error: unknown) => ({
          ok: false,
          code: -1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        }))
      if (!installed.ok) {
        report.packages.push({
          spec: pkg.spec,
          outcome: 'failed',
          message: installed.stderr.slice(0, 300) || `退出码 ${installed.code}`,
        })
        continue
      }
      const checked = await shell.exec(pkg.verify, { timeoutMs: VERIFY_TIMEOUT_MS }).catch(() => ({
        ok: false,
        code: -1,
        stdout: '',
        stderr: '',
      }))
      report.packages.push(
        checked.ok
          ? { spec: pkg.spec, outcome: 'installed' }
          : { spec: pkg.spec, outcome: 'failed', message: '安装成功但 verify 未通过' },
      )
    }
  }

  // ── ② 技能与配置文件 ──────────────────────────────────────

  private async materializeSkills(
    shell: SetupShell,
    skills: { key: string; files: { path: string; content: string }[] }[],
    report: WorkspaceSetupReport,
  ): Promise<void> {
    for (const skill of skills) {
      try {
        for (const file of skill.files) {
          await shell.write(`.agents/${skill.key}/${file.path}`, file.content)
        }
        report.skills.push({ skillKey: skill.key, outcome: 'materialized' })
      } catch (error) {
        report.skills.push({
          skillKey: skill.key,
          outcome: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async materializeFiles(shell: SetupShell, files: WorkspaceSetupFile[]): Promise<void> {
    for (const file of files) {
      // 非凭据配置失败不阻断初始化：记日志即可（它通常是可选的辅助配置）
      await shell.write(file.path, file.content).catch((error: unknown) =>
        this.logger.warn('workspace.setup.file_failed', {
          path: file.path,
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  /**
   * ③ 凭据落地 + ④ 写版本 / 清单（run 与 syncCredentials 共用同一段逻辑）。
   *
   * 版本由**执行面自己从库里算**（`credentialVersionOf`），与 main 推送时算的值必然一致；
   * 这样 ensure 时不必问控制面也能判断"落后"。
   */
  private async applyCredentials(
    workspaceId: string,
    shell: SetupShell,
    plan: ResolvedPlan,
    report: WorkspaceSetupReport,
  ): Promise<{
    env: Record<string, string>
    version: string
    manifest: { provider: string; name: string; expiresAt: string | null }[]
    resolved: boolean
  }> {
    const { env, manifest, resolved } = await this.materializeCredentials(
      workspaceId,
      shell,
      plan,
      report,
    )
    const rows = await this.repo.listActiveCredentialVersions(plan.owner)
    const version = credentialVersionOf(rows)

    await shell
      .write(
        '.billy/setup.json',
        JSON.stringify(
          {
            setupId: plan.setupId,
            hash: plan.hash,
            credentialVersion: version,
            generatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      )
      .catch(() => undefined)
    await shell
      .write('.billy/credentials.json', JSON.stringify({ version, items: manifest }, null, 2))
      .catch(() => undefined)
    return { env, version, manifest, resolved }
  }

  // ── ③ 凭据落地 ─────────────────────────────────────────────

  private async materializeCredentials(
    workspaceId: string,
    shell: SetupShell,
    plan: ResolvedPlan,
    report: WorkspaceSetupReport,
  ): Promise<{
    env: Record<string, string>
    manifest: { provider: string; name: string; expiresAt: string | null }[]
    /** 整体解析是否成功；false 表示暂态失败（不是"确实没有凭据"） */
    resolved: boolean
  }> {
    const names = await this.repo.listActiveCredentialNames(plan.owner)
    // 没有绑定任何凭据：这不是失败，别让补偿逻辑一直重试
    if (names.length === 0) return { env: {}, manifest: [], resolved: true }

    let items: CredentialResolvedItem[]
    try {
      items = await this.credentials.resolve({ ...plan.owner, names })
    } catch (error) {
      for (const name of names) {
        report.credentials.push({
          name,
          outcome: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
      this.logger.warn('workspace.setup.credentials_failed', {
        workspaceId,
        reason: error instanceof Error ? error.message : String(error),
      })
      // **暂态失败**：空清单不能当成"解析成功"，否则拒绝语义会被永久化（issue 9）
      return { env: {}, manifest: [], resolved: false }
    }

    const env: Record<string, string> = {}
    const manifest: { provider: string; name: string; expiresAt: string | null }[] = []
    for (const item of items) {
      manifest.push({ provider: item.provider, name: item.name, expiresAt: item.expiresAt })
      if (item.status !== 'active' || !item.secret) {
        report.credentials.push({
          name: item.name,
          outcome: item.status === 'missing' ? 'skipped' : 'denied',
          message: item.message ?? `凭据状态：${item.status}`,
        })
        continue
      }
      const rendered = renderInjectRules(item.inject as CredentialInjectRule[], {
        config: item.config,
        secret: item.secret,
      })
      try {
        for (const file of rendered.files) {
          await shell.write(file.path, file.content, 600)
        }
        Object.assign(env, rendered.env)
        report.credentials.push({
          name: item.name,
          outcome: rendered.errors.length > 0 ? 'failed' : 'materialized',
          ...(rendered.errors.length > 0 ? { message: rendered.errors.join('；') } : {}),
        })
      } catch (error) {
        report.credentials.push({
          name: item.name,
          outcome: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { env, manifest, resolved: true }
  }

  // ── 契约形状收敛 ──────────────────────────────────────────

  private asPackages(value: unknown): WorkspaceSetupPackage[] {
    return Array.isArray(value) ? (value as WorkspaceSetupPackage[]) : []
  }

  private asFiles(value: unknown): WorkspaceSetupFile[] {
    return Array.isArray(value) ? (value as WorkspaceSetupFile[]) : []
  }

  private asEnv(value: unknown): Record<string, string> {
    return value && typeof value === 'object' ? (value as Record<string, string>) : {}
  }
}
