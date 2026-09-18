import type { Template } from '../types.js'
import { json, renderFile } from './utils.js'

export function createClientTemplate(name: string): Template {
  return {
    directory: 'apps',
    files: {
      'package.json': json({
        name: `@app/${name}`,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: {
          dev: 'next dev',
          build: 'next build',
          start: 'next start',
          // 前端质量门（与 apps/web / apps/admin 对齐）：根 `pnpm typecheck` 靠它才能覆盖新前端包，
          // 缺了会被 `pnpm check:ui` 拦下（见 docs/design/frontend-foundation.md）
          typecheck: 'tsc --noEmit',
        },
        dependencies: {
          '@repo/http-client': 'workspace:*',
          '@repo/sdk': 'workspace:*',
          '@repo/shared': 'workspace:*',
          '@repo/ui': 'workspace:*',
          '@tanstack/react-form': '^1.33.2',
          '@tanstack/react-query': '^5.101.4',
          '@tanstack/react-store': '^0.11.0',
          clsx: '^2.1.1',
          dayjs: '^1.11.21',
          immer: '^11.1.15',
          lodash: '^4.18.1',
          'lucide-react': '^1.30.0',
          next: '16.3.5',
          react: '^19.3.0',
          'react-dom': '^19.3.0',
          shadcn: '^4.16.2',
          'tailwind-merge': '^3.6.0',
          'tw-animate-css': '^1.4.0',
          'use-immer': '^0.11.0',
          zod: '^4.4.3',
          zustand: '^5.0.14',
        },
        devDependencies: {
          '@tailwindcss/postcss': '^4',
          '@types/lodash': '^4.17.24',
          '@types/node': '^26.1.1',
          '@types/react': '^19.3.0',
          '@types/react-dom': '^19.3.0',
          tsx: '^4.23.13',
          typescript: '^7.0.2',
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
          allowImportingTsExtensions: true,
          plugins: [{ name: 'next' }],
          paths: {
            '@/*': ['./src/*'],
            '#lib/*': ['../../packages/ui/src/lib/*'],
            '#components/*': ['../../packages/ui/src/components/*'],
            '#hooks/*': ['../../packages/ui/src/hooks/*'],
          },
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
      'next-env.d.ts': renderFile('client/next-env', {}),
      'next.config.ts': renderFile('client/next-config', {}),
      'postcss.config.mjs': renderFile('client/postcss-config', {}),
      'src/app/layout.tsx': renderFile('client/layout', { name }),
      'src/app/page.tsx': renderFile('client/page', {}),
      'src/app/globals.css': renderFile('client/globals-css', {}),
      // 应用级兜底：文件必须在位，版式来自 @repo/ui（与 apps/web / apps/admin 同一套）
      'src/app/error.tsx': renderFile('client/error', {}),
      'src/app/not-found.tsx': renderFile('client/not-found', {}),
      'src/app/loading.tsx': renderFile('client/loading', {}),
      'src/lib/constants.ts': renderFile('client/constants', { name }),
      // 应用装配：机制在 @repo/sdk 的 createAppClients，这里只注入取值与 401 善后
      'src/lib/server-client.ts': renderFile('client/server-client', {}),
      'src/providers/AppProviders.tsx': renderFile('client/app-providers', {}),
    },
  }
}
