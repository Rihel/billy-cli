import 'dotenv/config'
import { createServiceContext } from '@repo/kits'
import { AdminEntity } from '../src/database/entities/admin-entity.js'
import { AdminRepository } from '../src/modules/admin/admin.repository.js'
import { AdminService } from '../src/modules/admin/admin.service.js'

/**
 * 初始化第一个后台管理员账号（幂等：重复执行因邮箱唯一会报错并退出）。
 *
 * 用法：
 *   pnpm seed:admin
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=secret pnpm seed:admin
 *
 * 前置：数据库可连接（表由 sync 或迁移创建）。
 */
const main = async () => {
  const email = process.env.ADMIN_EMAIL ?? 'admin@billy.local'
  const password = process.env.ADMIN_PASSWORD ?? 'admin123'
  const realName = process.env.ADMIN_REAL_NAME ?? '超级管理员'

  const ctx = createServiceContext({
    db: { url: process.env.DB_URL, entities: [AdminEntity], sync: true },
    // AdminService 依赖链需要：密码哈希（auth）/ 令牌（jwt）/ 会话（redis）
    auth: { passwordHashRounds: process.env.PASSWORD_HASH_ROUNDS },
    jwt: { secret: process.env.JWT_SECRET },
    redis: { url: process.env.REDIS_URL },
  })
    .addService(AdminRepository)
    .addService(AdminService)
  await ctx.start()

  try {
    const admin = await ctx.get(AdminService).create({ email, password, realName })
    console.log(`[seed-admin] created: ${admin.email} (${admin.id})`)
  } catch (error) {
    console.error(`[seed-admin] failed: ${(error as Error).message}`)
    process.exitCode = 1
  } finally {
    await ctx.stop()
  }
}

void main()
