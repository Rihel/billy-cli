import type { NextConfig } from 'next'
import path from 'path'
const isDev = process.env.NODE_ENV === 'development'
console.log(isDev)
const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '9000',
        pathname: '/**',
      },
    ],
  },
  /* config options here */
  output: !isDev ? 'standalone' : undefined,
  outputFileTracingRoot: !isDev ? path.join(__dirname, '../../') : undefined,
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
