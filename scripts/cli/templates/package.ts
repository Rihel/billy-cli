import type { Template } from '../types.js'
import { json, render, source } from './utils.js'

export function createPackageTemplate(name: string): Template {
  const data = { name }

  return {
    directory: 'packages',
    files: {
      'package.json': json({
        name: render('@repo/<%= it.name %>', data),
        version: '0.1.0',
        private: true,
        type: 'module',
        exports: {
          '.': {
            import: './dist/index.mjs',
            types: './src/index.ts',
            require: './dist/index.cjs',
          },
        },
        scripts: {
          dev: 'tsdown --watch --config-loader unrun',
          build: 'tsdown --config-loader unrun',
        },
        devDependencies: {
          tsdown: '^0.22.9',
          typescript: '^7.0.2',
          unrun: '^0.3.1',
        },
      }),
      'tsconfig.json': json({
        compilerOptions: {
          outDir: 'dist',
          rootDir: 'src',
          module: 'esnext',
          target: 'esnext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          resolveJsonModule: true,
          strict: true,
          skipLibCheck: true,
          noImplicitAny: false,
          strictNullChecks: false,
          strictPropertyInitialization: false,
          verbatimModuleSyntax: false,
        },
        include: ['src', 'tsdown.config.ts'],
        exclude: ['node_modules', 'dist'],
      }),
      'tsdown.config.ts': source`
        import { defineConfig } from 'tsdown'

        export default defineConfig({
          entry: ['./src/index.ts'],
          dts: true,
        })
      `,
      'src/index.ts': render(
        source`
          export const packageName = '@repo/<%= it.name %>'
        `,
        data,
      ),
    },
  }
}
