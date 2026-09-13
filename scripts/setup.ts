import { spawn } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import net from 'node:net'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { confirm } from '@inquirer/prompts'
import { Command } from 'commander'
import colors from 'picocolors'

/**
 * Billy 一键初始化引导（pnpm bootstrap）：
 * 环境检查 → Docker 依赖服务 → 生成 .env → 安装依赖 → 迁移 → 管理员种子 → 冒烟验证。
 * 每步可跳过（--skip-*），交互确认；--yes 全用默认值（适合 CI / 脚本）。
 *
 * 注：命令名取 bootstrap 而非 setup —— pnpm 存在内建 setup 命令，
 * 会拦截传给脚本的参数（-y / --skip-* 等），故避开撞名。
 */

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url))

const envFiles: Array<{ path: string; example: string; label: string }> = [
  {
    path: 'apps/server/.env',
    example: 'apps/server/.env.example',
    label: '服务端',
  },
  {
    path: 'apps/admin/.env',
    example: 'apps/admin/.env.example',
    label: 'Admin 后台',
  },
  {
    path: 'apps/web/.env.local',
    example: 'apps/web/.env.local.example',
    label: 'Web 前台',
  },
]

/* ---------------- 工具 ---------------- */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 探测端口是否可连接（本机） */
const probePort = (
  port: number,
  host = '127.0.0.1',
  timeoutMs = 1000,
): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })

/** 执行命令，返回退出码（继承 stdio） */
const run = (
  command: string,
  args: string[],
  cwd: string = workspaceRoot,
): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', () => resolve(1))
    child.once('exit', (code) => resolve(code ?? 1))
  })

/** 交互确认：--yes 时直接返回默认值 */
const ask = (message: string, fallback: boolean, yes: boolean): Promise<boolean> =>
  yes ? Promise.resolve(fallback) : confirm({ message, default: fallback })

/** 轮询等待 HTTP 服务可响应 */
const waitForHttp = async (
  url: string,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: 'POST' })
      if (response.ok) return true
    } catch {
      // 服务尚未就绪，继续轮询
    }
    await sleep(1000)
  }
  return false
}

/* ---------------- 各步骤 ---------------- */

async function checkEnvironment(): Promise<boolean> {
  console.log(colors.cyan('\n[1/6] 环境检查'))

  const nodeMajor = Number(process.version.replace(/^v/, '').split('.')[0])
  if (Number.isNaN(nodeMajor) || nodeMajor < 20) {
    console.error(
      colors.red(`  ✗ Node.js 版本过低（当前 ${process.version}），需要 >= 20`),
    )
    return false
  }
  console.log(colors.green(`  ✓ Node.js ${process.version}`))

  const pnpmCheck = spawn('pnpm', ['--version'], {
    cwd: workspaceRoot,
    stdio: 'ignore',
  })
  const pnpmOk = await new Promise<boolean>((resolve) => {
    pnpmCheck.once('error', () => resolve(false))
    pnpmCheck.once('exit', (code) => resolve(code === 0))
  })
  if (!pnpmOk) {
    console.error(
      colors.red(
        '  ✗ 未找到 pnpm，请先安装：corepack enable && corepack prepare pnpm@11.15.0 --activate',
      ),
    )
    return false
  }
  console.log(colors.green('  ✓ pnpm 可用'))

  return true
}

async function ensureDockerServices(yes: boolean, skip: boolean): Promise<void> {
  console.log(colors.cyan('\n[2/6] Docker 依赖服务（postgres / redis / minio）'))

  if (skip) {
    console.log(colors.yellow('  - 已跳过（--skip-docker），请自行保证依赖可用'))
    return
  }

  // 兼容两种场景：compose 宿主端口（15432/6380/19000）或本机服务（5432/6379/9000）
  const pgReady = (await probePort(15432)) || (await probePort(5432))
  const redisReady = (await probePort(6380)) || (await probePort(6379))
  const minioReady = (await probePort(19000)) || (await probePort(9000))

  if (pgReady && redisReady && minioReady) {
    console.log(colors.green('  ✓ PostgreSQL / Redis / MinIO 均已在运行'))
    return
  }

  const summary = [
    `PostgreSQL ${pgReady ? '✓' : '✗'}`,
    `Redis ${redisReady ? '✓' : '✗'}`,
    `MinIO ${minioReady ? '✓' : '✗'}`,
  ].join('  ')
  console.log(`  当前状态：${summary}`)

  if (!(await ask('通过 docker compose 启动缺失的依赖服务？', true, yes))) {
    console.log(colors.yellow('  - 跳过依赖启动，请自行保证服务可用'))
    return
  }

  const code = await run('docker', ['compose', 'up', '-d', 'postgres', 'redis', 'minio'])
  if (code !== 0) {
    console.error(
      colors.red('  ✗ docker compose 启动失败，请检查 Docker 是否已安装并运行'),
    )
    process.exit(1)
  }

  // 轮询等待 compose 宿主端口就绪（最多 90 秒）
  const deadline = Date.now() + 90_000
  let pgUp = pgReady
  let redisUp = redisReady
  let minioUp = minioReady
  process.stdout.write('  等待服务就绪')
  while (Date.now() < deadline && !(pgUp && redisUp && minioUp)) {
    if (!pgUp) pgUp = await probePort(15432)
    if (!redisUp) redisUp = await probePort(6380)
    if (!minioUp) minioUp = await probePort(19000)
    process.stdout.write('.')
    await sleep(2000)
  }
  console.log()

  if (pgUp && redisUp && minioUp) {
    console.log(
      colors.green('  ✓ 依赖服务已就绪（PostgreSQL 15432 / Redis 6380 / MinIO 19000）'),
    )
  } else {
    console.error(
      colors.red('  ✗ 等待超时：依赖服务未全部就绪，请检查 docker compose ps'),
    )
    process.exit(1)
  }
}

async function ensureEnvFiles(yes: boolean): Promise<void> {
  console.log(colors.cyan('\n[3/6] 环境变量文件（.env）'))

  for (const file of envFiles) {
    const target = `${workspaceRoot}/${file.path}`
    if (existsSync(target)) {
      console.log(colors.yellow(`  - ${file.label} ${file.path} 已存在，保留原配置`))
      continue
    }
    copyFileSync(`${workspaceRoot}/${file.example}`, target)
    console.log(colors.green(`  ✓ 已生成 ${file.path}（从 ${file.example}）`))
  }

  if (!(await ask('检查并确认以上 .env 配置（数据库地址等）？', true, yes))) {
    console.error(colors.red('  请先修改 .env 后再运行 pnpm bootstrap'))
    process.exit(1)
  }
}

async function ensureDeps(yes: boolean, skip: boolean): Promise<void> {
  console.log(colors.cyan('\n[4/6] 依赖安装'))

  if (skip) {
    console.log(colors.yellow('  - 已跳过（--skip-install）'))
    return
  }

  const installed = existsSync(`${workspaceRoot}/node_modules`)
  if (installed && !(await ask('node_modules 已存在，重新安装依赖？', false, yes))) {
    console.log(colors.yellow('  - 跳过 pnpm install'))
    return
  }

  const code = await run('pnpm', ['install'])
  if (code !== 0) {
    console.error(colors.red('  ✗ pnpm install 失败'))
    process.exit(1)
  }
  console.log(colors.green('  ✓ 依赖安装完成'))
}

async function migrateDatabase(yes: boolean, skip: boolean): Promise<void> {
  console.log(colors.cyan('\n[5/6] 数据库迁移与种子数据'))

  if (skip) {
    console.log(colors.yellow('  - 已跳过（--skip-migrate）'))
    return
  }

  if (!(await ask('执行数据库迁移（pnpm db:migrate）？', true, yes))) {
    console.log(colors.yellow('  - 跳过迁移'))
    return
  }

  const code = await run('pnpm', ['db:migrate'])
  if (code !== 0) {
    console.error(
      colors.red('  ✗ 迁移失败：请确认 PostgreSQL 已启动且 apps/server/.env 的 DB_URL 正确'),
    )
    process.exit(1)
  }
  console.log(colors.green('  ✓ 迁移完成'))

  if (!(await ask('创建首个管理员（admin@billy.local / admin123）？', true, yes))) {
    return
  }
  const seedCode = await run('pnpm', ['seed:admin'])
  if (seedCode !== 0) {
    // 幂等性说明：重复执行会因邮箱唯一报错，属于可忽略情况
    console.log(
      colors.yellow('  - 种子执行未成功（若已存在管理员账号，可忽略）'),
    )
  } else {
    console.log(
      colors.green('  ✓ 管理员已创建：admin@billy.local / admin123（请尽快修改密码）'),
    )
  }
}

async function smokeTest(yes: boolean, skip: boolean): Promise<void> {
  console.log(colors.cyan('\n[6/6] 服务冒烟验证'))

  if (skip) {
    console.log(colors.yellow('  - 已跳过（--skip-smoke）'))
    return
  }

  const serverUrl = 'http://localhost:9989/config/get'
  const alreadyRunning = await probePort(9989)
  const child =
    alreadyRunning
      ? null
      : spawn(
          'pnpm',
          ['--filter', '@app/server', 'exec', 'tsx', 'src/main.ts'],
          { cwd: workspaceRoot, detached: true, stdio: 'ignore' },
        )

  process.stdout.write('  正在启动服务并请求 /config/get')
  const ok = await waitForHttp(serverUrl, 45_000)
  console.log()

  if (child && child.pid) {
    // detached 子进程为独立进程组，负 pid 信号可整组终止
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // 进程已退出
    }
  }

  if (ok) {
    console.log(colors.green('  ✓ 服务启动成功，API 可正常响应（冒烟通过）'))
  } else {
    console.error(
      colors.red(
        '  ✗ 冒烟失败：服务未在 45 秒内响应。请检查 apps/server/.env（DB_URL / REDIS_URL）与依赖服务状态',
      ),
    )
    process.exit(1)
  }
}

/* ---------------- 入口 ---------------- */

interface SetupOptions {
  yes: boolean
  skipDocker: boolean
  skipInstall: boolean
  skipMigrate: boolean
  skipSeed: boolean
  skipSmoke: boolean
}

const main = async (): Promise<void> => {
  const program = new Command()
    .name('pnpm bootstrap')
    .description('Billy 一键初始化：环境检查 → 依赖服务 → .env → 安装 → 迁移 → 种子 → 冒烟')
    .option('-y, --yes', '所有交互使用默认值（非交互，适合 CI / 脚本）')
    .option('--skip-docker', '跳过 Docker 依赖服务启动')
    .option('--skip-install', '跳过依赖安装')
    .option('--skip-migrate', '跳过数据库迁移')
    .option('--skip-seed', '跳过管理员种子创建')
    .option('--skip-smoke', '跳过服务冒烟验证')
    .helpOption('-h, --help', '显示帮助')
    .showHelpAfterError()
    // `pnpm run bootstrap` 场景下 pnpm 会注入脚本名作为位置参数，忽略之
    .allowExcessArguments(true)

  program.parse()
  const options = program.opts<SetupOptions>()

  console.log(colors.bold(colors.cyan('\nBilly 一键初始化（pnpm bootstrap）')))

  if (!(await checkEnvironment())) process.exit(1)
  await ensureDockerServices(options.yes, options.skipDocker)
  await ensureEnvFiles(options.yes)
  await ensureDeps(options.yes, options.skipInstall)
  await migrateDatabase(options.yes, options.skipMigrate)
  await smokeTest(options.yes, options.skipSmoke)

  console.log(colors.bold(colors.green('\n✅ 初始化完成，启动开发环境：')))
  console.log(`  ${colors.cyan('pnpm dev:pkgs')}    # 终端 1：watch 构建 packages`)
  console.log(`  ${colors.cyan('pnpm dev:server')}   # 终端 2：NestJS 服务（http://localhost:9989）`)
  console.log(`  ${colors.cyan('pnpm dev:web')}      # 终端 3：Web 前台（http://localhost:9840）`)
  console.log(`  ${colors.cyan('pnpm dev:admin')}    # 终端 4（可选）：Admin 后台（http://localhost:9845）`)
  console.log(
    `\n  Admin 登录：${colors.bold('admin@billy.local')} / ${colors.bold('admin123')}`,
  )
  console.log(
    colors.yellow('  提示：-y 全默认 / --skip-* 跳过指定步骤，适合重复执行与 CI。'),
  )
}

main().catch((error: unknown) => {
  console.error(colors.red(`setup 执行失败：${(error as Error).message}`))
  process.exit(1)
})
