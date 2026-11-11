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
  // 本地用 127.0.0.1 打开时，Next 16 会把 dev 资源当跨源请求拦掉（页面不水合、交互失效）
  allowedDevOrigins: ['127.0.0.1', 'localhost', '192.168.3.10', '192.168.3.*'],

  transpilePackages: ['@repo/ui'],
  serverExternalPackages: [
    '@repo/shared',
    'pino',
    'pino-pretty',
    'pg',
    'typeorm',
  ],
}

export default nextConfig
