import type { NextConfig } from 'next'
import path from 'path'
const isDev = process.env.NODE_ENV === 'development'

const nextConfig: NextConfig = {
  transpilePackages: ['@repo/ui'],
  typescript: {
    ignoreBuildErrors: true,
  },
  // 本地用 127.0.0.1 打开时，Next 16 会把 dev 资源当跨源请求拦掉（页面不水合、交互失效）
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  output: !isDev ? 'standalone' : undefined,
  outputFileTracingRoot: !isDev ? path.join(__dirname, '../../') : undefined,
  reactCompiler: true,
}

export default nextConfig
