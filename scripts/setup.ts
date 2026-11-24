import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { confirm } from '@inquirer/prompts'
import { Command } from 'commander'
import colors from 'picocolors'

/**
 * Billy 一键初始化引导（pnpm bootstrap）：
 * 环境检查 → Docker 依赖服务 → 生成 .env → 安装依赖 → 构建 packages → 迁移 / 种子 → 冒烟验证。
 * 每步可跳过（--skip-*），交互确认；--yes 全用默认值（适合 CI / 脚本）。
 *
 * 入口是 scripts/bootstrap.mjs（纯 Node）：它先补齐 node_modules（setup.ts 自己跑在 tsx 上），
 * 再把参数转给本文件。所以全新克隆直接 `pnpm bootstrap` 即可。
 *
 * 注：命令名取 bootstrap 而非 setup —— pnpm 存在内建 setup 命令，
 * 会拦截传给脚本的参数（-y / --skip-* 等），故避开撞名。
 */

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url))

const envFiles: Array<{ path: string; example: string; label: string }> = [
  {
    path: 'apps/main/.env',
    example: 'apps/main/.env.example',
    label: 'main（公网 API / 控制面）',
  },
  {
    path: 'apps/agent-runtime/.env',
    example: 'apps/agent-runtime/.env.example',
    label: 'agent-runtime（会话运行时）',
  },
  {
    path: 'apps/model-gateway/.env',
    example: 'apps/model-gateway/.env.example',
    label: 'model-gateway（模型网关）',
  },
  {
    path: 'apps/capability-gateway/.env',
    example: 'apps/capability-gateway/.env.example',
    label: 'capability-gateway（工具网关）',
  },
  {
    path: 'apps/common-capability/.env',
    example: 'apps/common-capability/.env.example',
    label: 'common-capability（工具执行）',
  },
  {
    path: 'apps/workspace-service/.env',
    example: 'apps/workspace-service/.env.example',
    label: 'workspace-service（工作区执行面）',
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

const isWin = process.platform === 'win32'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 终止服务进程树。
 *
 * 为什么不能只 `process.kill(-pid)`：Windows 没有进程组语义，负 pid 会直接抛错；
 * 而 `node` 启动的 Nest 进程树里可能有 tsx loader / esbuild 等子进程，只杀父进程会留孤儿占住 9989。
 * 所以 Windows 走 `taskkill /T /F`（同步执行，确保退出前端口已释放），POSIX 走进程组信号。
 */
const stopTree = (pid: number): void => {
  if (isWin) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      // 进程已退出
    }
    return
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // 进程已退出
  }
}

/** 探测端口是否可连接（本机） */
const probePort = (port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> =>
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
const run = (command: string, args: string[], cwd: string = workspaceRoot): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', () => resolve(1))
    child.once('exit', (code) => resolve(code ?? 1))
  })

/** 交互确认：--yes 时直接返回默认值 */
const ask = (message: string, fallback: boolean, yes: boolean): Promise<boolean> =>
  yes ? Promise.resolve(fallback) : confirm({ message, default: fallback })

/** 轮询等待 HTTP 服务可响应 */
const waitForHttp = async (url: string, timeoutMs: number): Promise<boolean> => {
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
  console.log(colors.cyan('\n[1/7] 环境检查'))

  // 与 package.json 的 engines 保持一致（README 写的是 >= 26）；低于它的人会在这里被拦下，
  // 而不是在 build / dev 阶段收到一堆语法或依赖错误
  const nodeMajor = Number(process.version.replace(/^v/, '').split('.')[0])
  if (Number.isNaN(nodeMajor) || nodeMajor < 26) {
    console.error(colors.red(`  ✗ Node.js 版本过低（当前 ${process.version}），需要 >= 26`))
    return false
  }
  console.log(colors.green(`  ✓ Node.js ${process.version}`))

  const installHint =
    'npm install -g pnpm@12.18.0（Node 26 不再内置 corepack，不能用 corepack 安装）'
  let pnpmVersion = ''
  try {
    pnpmVersion = execFileSync('pnpm', ['--version'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    }).trim()
  } catch {
    console.error(colors.red(`  ✗ 未找到 pnpm，请先安装：${installHint}`))
    return false
  }
  const pnpmMajor = Number(pnpmVersion.split('.')[0])
  if (!Number.isFinite(pnpmMajor) || pnpmMajor < 12) {
    console.error(
      colors.red(`  ✗ pnpm 版本过低（当前 ${pnpmVersion}），需要 >= 12（packageManager）`),
    )
    return false
  }
  console.log(colors.green(`  ✓ pnpm ${pnpmVersion}`))

  return true
}

async function ensureDockerServices(yes: boolean, skip: boolean): Promise<void> {
  console.log(colors.cyan('\n[2/7] Docker 依赖服务（postgres / redis / minio）'))

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
    console.error(colors.red('  ✗ docker compose 启动失败，请检查 Docker 是否已安装并运行'))
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
    console.log(colors.green('  ✓ 依赖服务已就绪（PostgreSQL 15432 / Redis 6380 / MinIO 19000）'))
  } else {
    console.error(colors.red('  ✗ 等待超时：依赖服务未全部就绪，请检查 docker compose ps'))
    process.exit(1)
  }
}

const replaceInFile = (relativePath: string, pairs: readonly [string, string][]): void => {
  const full = `${workspaceRoot}/${relativePath}`
  let text = readFileSync(full, 'utf8')
  for (const [from, to] of pairs) text = text.split(from).join(to)
  writeFileSync(full, text)
}

/** 读 .env 里某个键的值（没有返回 undefined） */
const readEnvValue = (relativePath: string, key: string): string | undefined => {
  const text = readFileSync(`${workspaceRoot}/${relativePath}`, 'utf8')
  const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'))
  return match?.[1]
}

/** 覆盖 .env 里某个键的值（只替换该行，保留注释与其它键） */
const setEnvValue = (relativePath: string, key: string, value: string): void => {
  const full = `${workspaceRoot}/${relativePath}`
  const text = readFileSync(full, 'utf8')
  // 用函数式替换：值里若含 `$` 不会被当成替换模式
  writeFileSync(
    full,
    text.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}=${value}`),
  )
}

async function ensureEnvFiles(yes: boolean): Promise<void> {
  console.log(colors.cyan('\n[3/7] 环境变量文件（.env）'))

  const created: string[] = []
  for (const file of envFiles) {
    const target = `${workspaceRoot}/${file.path}`
    if (existsSync(target)) {
      console.log(colors.yellow(`  - ${file.label} ${file.path} 已存在，保留原配置`))
      continue
    }
    copyFileSync(`${workspaceRoot}/${file.example}`, target)
    created.push(file.path)
    console.log(colors.green(`  ✓ 已生成 ${file.path}（从 ${file.example}）`))
  }

  /**
   * 端口对齐：模板按「本机服务」写（5432 / 6379 / 9000），docker compose 映射的是
   * 15432 / 6380 / 19000 —— 不对齐的话，bootstrap 刚刚用 compose 拉起依赖，
   * 下一步 `pnpm db:migrate` 却连本机 5432，全新机器上会直接失败。
   * 只改**刚刚生成**的文件；已有 .env 是用户配置，不碰。
   *
   * model-gateway / workspace-service 的库地址不按端口猜，直接跟 main 对齐：
   * 它们本来就必须连同一个库，读 main/.env 的 DB_URL（上面已按 compose 调过）最稳。
   */
  if (created.length > 0) {
    const composePg = (await probePort(15432)) && !(await probePort(5432))
    const composeRedis = (await probePort(6380)) && !(await probePort(6379))
    const composeMinio = (await probePort(19000)) && !(await probePort(9000))

    const envTargets = [
      'apps/main/.env',
      'apps/agent-runtime/.env',
      'apps/capability-gateway/.env',
      'apps/common-capability/.env',
    ].filter((file) => created.includes(file))
    if (envTargets.length > 0) {
      const pairs: Array<[string, string]> = []
      if (composePg) {
        pairs.push([
          'postgresql://root:pg1234@localhost:5432/billy-cli',
          'postgresql://root:pg1234@localhost:15432/billy-cli',
        ])
      }
      if (composeRedis) pairs.push(['redis://localhost:6379/0', 'redis://localhost:6380/0'])
      if (composeMinio) {
        pairs.push(
          ['http://localhost:9000/billy-cli', 'http://localhost:19000/billy-cli'],
          ['http://localhost:9000', 'http://localhost:19000'],
        )
      }
      if (pairs.length > 0) {
        for (const file of envTargets) replaceInFile(file, pairs)
        console.log(
          colors.green(
            '  ✓ main / agent-runtime / capability-gateway / common-capability .env 已对齐到 compose 端口',
          ),
        )
      }
    }

    if (composeMinio) {
      let frontAligned = false
      for (const file of ['apps/admin/.env', 'apps/web/.env.local']) {
        if (created.includes(file)) {
          replaceInFile(file, [
            ['http://localhost:9000/billy-cli', 'http://localhost:19000/billy-cli'],
          ])
          frontAligned = true
        }
      }
      if (frontAligned) {
        console.log(colors.green('  ✓ 前端 .env 的对象存储地址已对齐到 19000'))
      }
    }

    // 两个内网服务：库 / Redis 跟 main 走（compose 与「本机服务」两种形态都适用）
    const mainDb = readEnvValue('apps/main/.env', 'DB_URL')
    const mainRedis = readEnvValue('apps/main/.env', 'REDIS_URL')

    if (mainDb && created.includes('apps/model-gateway/.env')) {
      setEnvValue('apps/model-gateway/.env', 'DB_URL', mainDb)
      if (mainRedis) setEnvValue('apps/model-gateway/.env', 'REDIS_URL', mainRedis)
      console.log(colors.green('  ✓ model-gateway .env 的 DB / Redis 已与 main 对齐'))
    }

    if (mainDb && created.includes('apps/workspace-service/.env')) {
      setEnvValue('apps/workspace-service/.env', 'WORKSPACE_DB_URL', mainDb)
      console.log(colors.green('  ✓ workspace-service .env 的 WORKSPACE_DB_URL 已与 main 对齐'))
    }
  }

  if (!(await ask('检查并确认以上 .env 配置（数据库地址等）？', true, yes))) {
    console.error(colors.red('  请先修改 .env 后再运行 pnpm bootstrap'))
    process.exit(1)
  }
}

async function ensureDeps(yes: boolean, skip: boolean): Promise<void> {
  console.log(colors.cyan('\n[4/7] 依赖安装'))

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

/**
 * 构建 packages（`pnpm build:pkgs`）。
 *
 * 为什么必须在迁移之前：`@repo/*` 的运行时入口是 `dist/index.mjs`（`dist` 被 gitignore），
 * 全新克隆里没有产物 —— 不先构建，`pnpm db:migrate` / `seed:admin` / 冒烟都会
 * ERR_MODULE_NOT_FOUND。
 */
async function buildPackages(yes: boolean, skip: boolean): Promise<void> {
  console.log(colors.cyan('\n[5/7] 构建 packages'))

  if (skip) {
    console.log(
      colors.yellow(
        '  - 已跳过（--skip-build）；未构建时迁移 / 种子 / 冒烟会因找不到 @repo/* 的 dist 失败',
      ),
    )
    return
  }

  if (!(await ask('构建 packages（pnpm build:pkgs）？', true, yes))) {
    console.log(colors.yellow('  - 跳过构建；后续步骤可能因 packages 未构建失败'))
    return
  }

  const code = await run('pnpm', ['build:pkgs'])
  if (code !== 0) {
    console.error(colors.red('  ✗ pnpm build:pkgs 失败'))
    process.exit(1)
  }
  console.log(colors.green('  ✓ packages 构建完成'))
}

async function migrateDatabase(yes: boolean, skip: boolean, skipSeed: boolean): Promise<void> {
  console.log(colors.cyan('\n[6/7] 数据库迁移与种子数据'))

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
      colors.red('  ✗ 迁移失败：请确认 PostgreSQL 已启动且 apps/agent-runtime/.env 的 DB_URL 正确'),
    )
    process.exit(1)
  }
  console.log(colors.green('  ✓ 迁移完成'))

  if (skipSeed) {
    console.log(colors.yellow('  - 已跳过管理员种子（--skip-seed）'))
    return
  }
  if (!(await ask('创建首个管理员（admin@billy.local / admin123）？', true, yes))) {
    return
  }
  const seedCode = await run('pnpm', ['seed:admin'])
  if (seedCode !== 0) {
    // 幂等性说明：重复执行会因邮箱唯一报错，属于可忽略情况
    console.log(colors.yellow('  - 种子执行未成功（若已存在管理员账号，可忽略）'))
  } else {
    console.log(colors.green('  ✓ 管理员已创建：admin@billy.local / admin123（请尽快修改密码）'))
  }
}

async function smokeTest(yes: boolean, skip: boolean): Promise<void> {
  console.log(colors.cyan('\n[7/7] 服务冒烟验证'))

  if (skip) {
    console.log(colors.yellow('  - 已跳过（--skip-smoke）'))
    return
  }

  const serverUrl = 'http://localhost:9989/config/get'
  const mainRunning = await probePort(9989)
  // 冒烟只做「起服务进程 → 探活 → 停止」，不加 --watch，避免子进程常驻。
  // 六个 Nest 服务都拉起来：任何一个配置加载失败，都会在这里暴露。
  const children: Array<ReturnType<typeof spawn>> = []
  const startIfNeeded = async (port: number, app: string): Promise<void> => {
    if (await probePort(port)) return
    children.push(
      spawn(process.execPath, ['--import', 'tsx/esm', 'src/main.ts'], {
        cwd: join(workspaceRoot, `apps/${app}`),
        detached: !isWin,
        stdio: 'ignore',
      }),
    )
    await sleep(700)
  }
  await startIfNeeded(9994, 'common-capability')
  await startIfNeeded(9993, 'capability-gateway')
  await startIfNeeded(9992, 'model-gateway')
  await startIfNeeded(9990, 'agent-runtime')
  await startIfNeeded(9995, 'workspace-service')
  await sleep(700)
  if (!mainRunning) {
    children.push(
      spawn(process.execPath, ['--import', 'tsx/esm', 'src/main.ts'], {
        cwd: join(workspaceRoot, 'apps/main'),
        detached: !isWin,
        stdio: 'ignore',
      }),
    )
  }

  process.stdout.write('  正在启动六个服务并请求 main 的 /config/get')
  const ok = await waitForHttp(serverUrl, 45_000)
  console.log()

  for (const child of children) {
    if (child.pid) stopTree(child.pid)
  }

  if (ok) {
    console.log(colors.green('  ✓ 服务启动成功，API 可正常响应（冒烟通过）'))
  } else {
    console.error(
      colors.red(
        '  ✗ 冒烟失败：main 未在 45 秒内响应。请检查 apps/main/.env 与 apps/agent-runtime/.env（DB_URL / REDIS_URL）',
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
  skipBuild: boolean
  skipMigrate: boolean
  skipSeed: boolean
  skipSmoke: boolean
}

const main = async (): Promise<void> => {
  const program = new Command()
    .name('pnpm bootstrap')
    .description(
      'Billy 一键初始化：装依赖 → 环境检查 → 依赖服务 → 八份 .env → 构建 packages → 迁移 → 种子 → 冒烟',
    )
    .option('-y, --yes', '所有交互使用默认值（非交互，适合 CI / 脚本）')
    .option('--skip-docker', '跳过 Docker 依赖服务启动')
    .option('--skip-install', '跳过依赖安装')
    .option('--skip-build', '跳过 packages 构建（pnpm build:pkgs）')
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
  await buildPackages(options.yes, options.skipBuild)
  await migrateDatabase(options.yes, options.skipMigrate, options.skipSeed)
  await smokeTest(options.yes, options.skipSmoke)

  console.log(colors.bold(colors.green('\n✅ 初始化完成，启动开发环境：')))
  console.log(`  ${colors.cyan('pnpm dev:pkgs')}    # 终端 1：watch 构建 packages`)
  console.log(
    `  ${colors.cyan('pnpm dev:stack')}   # 终端 2：main(9989) + agent-runtime(9990) + tools + workspace(9995)`,
  )
  console.log(`  ${colors.cyan('pnpm dev:web')}      # 终端 3：Web 前台（http://localhost:9840）`)
  console.log(
    `  ${colors.cyan('pnpm dev:admin')}    # 终端 4（可选）：Admin 后台（http://localhost:9845）`,
  )
  console.log(`\n  Admin 登录：${colors.bold('admin@billy.local')} / ${colors.bold('admin123')}`)
  console.log(
    colors.yellow(
      '  提示：-y 全默认 / --skip-(docker|install|build|migrate|seed|smoke) 跳过指定步骤，适合重复执行与 CI。',
    ),
  )
  console.log(
    colors.yellow(
      '  首次对话前记得配置模型供应商（apps/main/.env 的 MASTRA_API_KEY，或在 Admin 后台「模型管理」里配置）。',
    ),
  )
}

main().catch((error: unknown) => {
  console.error(colors.red(`setup 执行失败：${(error as Error).message}`))
  process.exit(1)
})
