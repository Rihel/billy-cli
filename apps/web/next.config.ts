import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  transpilePackages: ['@repo/ui'],
  serverExternalPackages: [
    'pino',
    'pino-pretty',
    'drizzle-orm',
    'drizzle-orm/node-postgres',
    'pg',
  ],
}

export default nextConfig
