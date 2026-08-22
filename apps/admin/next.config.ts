import type { NextConfig } from 'next'
import path from 'path'
const isDev = process.env.NODE_ENV === 'development'

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

  transpilePackages: ['@repo/aui'],
  serverExternalPackages: [
    '@repo/shared',
    '@repo/db',
    'pino',
    'pino-pretty',
    'pg',
    'typeorm',
  ],
}

export default nextConfig
