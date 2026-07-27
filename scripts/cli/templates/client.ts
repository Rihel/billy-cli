import type { Template } from '../types.js'
import { json, render, source } from './utils.js'

export function createClientTemplate(name: string): Template {
  const data = { name }

  return {
    directory: 'apps',
    files: {
      'package.json': json({
        name: render('@app/<%= it.name %>', data),
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: {
          dev: 'next dev',
          build: 'next build',
          start: 'next start',
        },
        dependencies: {
          '@ant-design/icons': '^6.3.2',
          '@ant-design/nextjs-registry': '^1.3.0',
          '@repo/shared': 'workspace:*',
          '@repo/ui': 'workspace:*',
          '@tanstack/react-query': '^5.101.4',
          '@repo/sdk': 'workspace:*',
          ahooks: '^3.9.7',
          antd: '^6.5.1',
          clsx: '^2.1.1',
          dayjs: '^1.11.21',
          'drizzle-orm': '1.0.0-rc.4',
          immer: '^11.1.15',
          lodash: '^4.18.1',
          next: '16.2.10',
          react: '^19.2.7',
          'react-dom': '^19.2.7',
          'tailwind-merge': '^3.6.0',
          'use-immer': '^0.11.0',
          zod: '^4.4.3',
          zustand: '^5.0.14',
        },
        devDependencies: {
          '@ant-design/static-style-extract': '^2.1.0',
          '@tailwindcss/postcss': '^4',
          '@types/lodash': '^4.17.24',
          '@types/node': '^26.1.1',
          '@types/react': '^19.2.17',
          '@types/react-dom': '^19.2.3',
          'babel-plugin-react-compiler': '1.0.0',
          tailwindcss: '^4',
          tsx: '^4.23.1',
          typescript: '^6.0.0',
        },
      }),
      'tsconfig.json': json({
        compilerOptions: {
          target: 'ES2017',
          lib: ['dom', 'dom.iterable', 'esnext'],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: 'react-jsx',
          incremental: true,
          plugins: [{ name: 'next' }],
          paths: { '@/*': ['./src/*'] },
        },
        include: [
          'next-env.d.ts',
          '**/*.ts',
          '**/*.tsx',
          '.next/types/**/*.ts',
          '.next/dev/types/**/*.ts',
        ],
        exclude: ['node_modules'],
      }),
      'next-env.d.ts': source`
        /// <reference types="next" />
        /// <reference types="next/image-types/global" />
      `,
      'next.config.ts': source`
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
          output: !isDev ? 'standalone' : undefined,
          outputFileTracingRoot: !isDev ? path.join(__dirname, '../../') : undefined,
          reactCompiler: true,
          experimental: { authInterrupts: true },
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
      `,
      'postcss.config.mjs': source`
        const config = {
          plugins: {
            '@tailwindcss/postcss': {},
          },
        }

        export default config
      `,
      'src/app/layout.tsx': render(
        source`
        import type { Metadata } from 'next'
        import { AntdRegistry } from '@ant-design/nextjs-registry'
        import type { ReactNode } from 'react'
        import './globals.css'
        import { AppName } from '@/lib/constants'
        import { Providers } from '@/providers/AppProviders'

        export const metadata: Metadata = {
          title: AppName,
          description: '<%= it.name %> application',
        }

        export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
          return (
            <html lang="zh-CN">
              <body>
                <AntdRegistry>
                  <Providers>{children}</Providers>
                </AntdRegistry>
              </body>
            </html>
          )
        }
        `,
        data,
      ),
      'src/app/page.tsx': source`
        import { Pages } from '@/lib/constants'
        import { redirect } from 'next/navigation'

        export default function HomePage() {
          return <div>hello world</div>
        }
      `,
      'src/app/globals.css': source`
        * {
          box-sizing: border-box;
        }

        html,
        body {
          margin: 0;
          min-height: 100%;
        }

        body {
          font-family: sans-serif;
        }
      `,
      'src/lib/constants.ts': render(
        source`
          export const Pages = {
            login: '/auth/login',
            dashboard: '/main/dashboard',
          }

          export const AppName = '<%= it.name %>'
        `,
        data,
      ),
      'src/providers/AppProviders.tsx': source`
        'use client'

        import { App, ConfigProvider } from 'antd'
        import zhCN from 'antd/locale/zh_CN'
        import type { ReactNode } from 'react'

        export function Providers({ children }: { children: ReactNode }) {
          return (
            <ConfigProvider
              locale={zhCN}
              variant="filled"
              theme={{ cssVar: { key: 'app' }, hashed: false }}
            >
              <App>{children}</App>
            </ConfigProvider>
          )
        }
      `,
    },
  }
}
