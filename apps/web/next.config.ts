import type { NextConfig } from 'next'
import path from 'path'

const nextConfig: NextConfig = {
  /* config options here */
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  reactCompiler: true,
  experimental: {
    authInterrupts: true,
  },
  transpilePackages: ['@repo/ui'],
  serverExternalPackages: [
    '@repo/shared',
    '@repo/db',
    'pino',
    'pino-pretty',
    'drizzle-orm',
    'drizzle-orm/node-postgres',
    'pg',
  ],
}

export default nextConfig
