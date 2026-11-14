import 'reflect-metadata'
import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { RootModule } from '../src/root.module.js'
import { loadServerAppConfig } from '../src/app-config.js'
import { AdminService } from '../src/modules/admin/index.js'

/**
 * 初始化第一个后台管理员账号（幂等：重复执行因邮箱唯一会报错并退出）。
 *
 * 用法：
 *   pnpm seed:admin
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=secret pnpm seed:admin
 *
 * 前置：数据库可连接（表由 sync 或迁移创建）。
 *
 * 实现说明：直接复用应用组合根（RootModule）以应用上下文启动，与线上装配完全一致，
 * 避免脚本自建装配与运行时漂移（`NestFactory.createApplicationContext` 不监听端口）。
 *
 * 退出说明：开发态日志走 pino-pretty，其 transport 是独立 worker 线程，**不随 `app.close()`
 * 结束**，会一直挂住事件循环（这也是 `node --watch` 下不会自动退出的原因）；
 * 脚本语义是「跑完即退」，故关闭应用后显式 `process.exit`。
 */
const main = async () => {
  const email = process.env.ADMIN_EMAIL ?? 'admin@billy.local'
  const password = process.env.ADMIN_PASSWORD ?? 'admin123'
  const realName = process.env.ADMIN_REAL_NAME ?? '超级管理员'

  // 与线上一致的配置链路：先加载校验应用配置，再启动应用上下文
  await loadServerAppConfig()

  const app = await NestFactory.createApplicationContext(RootModule, {
    logger: false,
  })

  try {
    const admin = await app.get(AdminService).create({ email, password, realName })
    console.log(`[seed-admin] created: ${admin.email} (${admin.id})`)
  } catch (error) {
    console.error(`[seed-admin] failed: ${(error as Error).message}`)
    process.exitCode = 1
  } finally {
    await app.close()
  }

  process.exit(process.exitCode ?? 0)
}

void main()
