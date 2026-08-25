/**
 * 初始化第一个后台管理员账号。
 *
 * 用法：
 *   pnpm seed:admin
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=secret pnpm seed:admin
 *
 * 前置：packages 已构建（pnpm build:pkgs）、数据库可连接（表由 sync 或迁移创建）。
 */
import { AdminService, appCore, initCore, startCore, stopCore } from '@repo/core'

const main = async () => {
  const email = process.env.ADMIN_EMAIL ?? 'admin@billy.local'
  const password = process.env.ADMIN_PASSWORD ?? 'admin123'
  const realName = process.env.ADMIN_REAL_NAME ?? '超级管理员'

  initCore({ db: { sync: true } })
  await startCore()

  const adminService = appCore.get(AdminService)
  try {
    const admin = await adminService.create({ email, password, realName })
    console.log(`[seed-admin] created: ${admin.email} (${admin.id})`)
  } catch (error) {
    console.error(`[seed-admin] failed: ${(error as Error).message}`)
    process.exitCode = 1
  } finally {
    await stopCore()
  }
}

void main()
