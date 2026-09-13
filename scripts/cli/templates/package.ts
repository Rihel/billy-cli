import type { Template } from '../types.js'
import { json, renderFile } from './utils.js'

export function createPackageTemplate(name: string): Template {
  return {
    directory: 'packages',
    files: {
      'package.json': json({
        name: `@repo/${name}`,
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
          tsdown: '^0.23.0',
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
      'tsdown.config.ts': renderFile('package/tsdown-config', {}),
      'src/index.ts': renderFile('package/src-index', { name }),
    },
  }
}
