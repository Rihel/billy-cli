/**
 * 把要内联进沙箱 iframe 的第三方库复制到 `public/vendor/`。
 *
 * 为什么需要这一步：AI 会话里的 `html` / `gsap` 围栏跑在沙箱 iframe 里，
 * 而那个 iframe 的 CSP 是 `default-src 'none'`（连不出去），所以库文件只能由父页面
 * 同源取回、内联进文档。放进 `public/vendor/` 是为了"不经过打包、直接按 URL 取"。
 *
 * 产物**随仓库提交**：构建镜像里不跑本脚本也能用；改动依赖版本后跑一次
 * `pnpm -F @app/admin sync:vendor` 同步，不要手改产物。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')

type VendorTarget = { name: string; packageJson: string; from: string; to: string }

/** 需要同步的库：`from` 是包内真实文件，`to` 是 public 下的目标路径 */
const TARGETS: VendorTarget[] = [
  {
    name: 'gsap',
    packageJson: 'node_modules/gsap/package.json',
    from: 'node_modules/gsap/dist/gsap.min.js',
    to: 'public/vendor/gsap.min.js',
  },
]

const run = async () => {
  for (const target of TARGETS) {
    const { version } = JSON.parse(await readFile(join(appRoot, target.packageJson), 'utf8')) as {
      version: string
    }
    const source = await readFile(join(appRoot, target.from), 'utf8')
    const destination = join(appRoot, target.to)
    await mkdir(dirname(destination), { recursive: true })
    const header = `/* ${target.name} ${version} · 由 scripts/sync-vendor.ts 生成，勿手改（改版本请重新同步） */\n`
    await writeFile(destination, `${header}${source}`, 'utf8')
    console.log(`[sync-vendor] ${target.name} ${version} → ${target.to}`)
  }
}

await run()
