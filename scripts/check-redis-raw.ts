/**
 * Redis 边界守卫：**业务 app 不得直接 `redis.raw`**。
 *
 * 规则（用户口径）：app 里只允许调用 `@repo/kits` 的 `RedisStore` 方法；
 * 缺什么能力，就去 `packages/kits/src/redis/redis-store.ts` 加方法，再回来用。
 *
 * 扫描范围：`apps/<app>/src/` 下的 .ts（不含测试）。kits 自己是 Redis 组件的实现，
 * 内部使用 ioredis 客户端不算越界；但 app 层出现 `.raw` 一律失败。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const APPS_ROOT = 'apps'
const VIOLATION =
  /redis\.raw|\.raw\.(?:hset|hgetall|zadd|zrem|rpush|ltrim|lrange|publish|ping|del|scanStream)/

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const files: string[] = []
for (const app of readdirSync(APPS_ROOT)) {
  const src = join(APPS_ROOT, app, 'src')
  try {
    if (statSync(src).isDirectory()) files.push(...walk(src))
  } catch {
    // 没有 src 的 app 跳过
  }
}

const violations: Array<{ file: string; line: number; code: string }> = []
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (VIOLATION.test(line)) {
      violations.push({ file: relative(process.cwd(), file), line: index + 1, code: line.trim() })
    }
  })
}

if (violations.length > 0) {
  console.error('[check:redis-raw] ❌ app 层禁止直接访问 redis.raw：')
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}  ${violation.code}`)
  }
  console.error('  缺什么能力，去 packages/kits/src/redis/redis-store.ts 加方法。')
  process.exit(1)
}

console.log(`[check:redis-raw] ✅ ${files.length} 个 app 文件未直接使用 redis.raw`)
