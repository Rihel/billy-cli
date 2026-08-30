import type { Template } from '../types.js'
import { json, renderFile } from './utils.js'

export function createServiceTemplate(name: string): Template {
  return {
    directory: 'apps',
    files: {
      'package.json': json({
        name: `@app/${name}`,
        version: '0.0.1',
        description: '',
        type: 'module',
        author: '',
        private: true,
        license: 'UNLICENSED',
        scripts: {
          build: 'node -e "require(\'node:fs\').rmSync(\'dist\',{recursive:true,force:true})" && tsc -p tsconfig.build.json',
          'build:docker': 'node -e "require(\'node:fs\').rmSync(\'dist\',{recursive:true,force:true})" && tsc -p tsconfig.build.json',
          start: 'node dist/main.js',
          dev: 'tsx watch src/main.ts',
          'start:debug': 'tsx --inspect watch src/main.ts',
          'start:prod': 'node dist/main.js',
          'db:generate': 'bash -c \'node --import tsx node_modules/typeorm/cli.js migration:generate "src/database/migrations/$0" -d ./data-source.ts\'',
          'db:migrate': 'node --import tsx node_modules/typeorm/cli.js migration:run -d ./data-source.ts',
        },
        dependencies: {
          '@hono/node-server': '^1.19.0',
          '@hono/zod-validator': '^0.7.0',
          '@repo/di': 'workspace:*',
          '@repo/kits': 'workspace:*',
          '@repo/shared': 'workspace:*',
          dotenv: '^17.4.2',
          hono: '^4.9.0',
          pg: '^8.22.0',
          typeorm: '^1.1.0',
          zod: '^4.4.3',
        },
        devDependencies: {
          '@types/node': '^24.0.0',
          tsx: '^4.23.1',
          typescript: '^7.0.2',
          'typescript-eslint': '^8.20.0',
        },
      }),
      'tsconfig.json': json({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          resolvePackageJsonExports: true,
          esModuleInterop: true,
          isolatedModules: true,
          declaration: false,
          types: ['node'],
          verbatimModuleSyntax: true,
          target: 'ES2023',
          sourceMap: true,
          rootDir: 'src',
          outDir: 'dist',
          skipLibCheck: true,
          strict: true,
          forceConsistentCasingInFileNames: true,
          noFallthroughCasesInSwitch: false,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          useDefineForClassFields: false,
        },
        include: ['src'],
      }),
      'tsconfig.build.json': json({
        extends: './tsconfig.json',
        exclude: ['node_modules', 'test', 'dist', '**/*spec.ts'],
      }),
      'data-source.ts': renderFile('service/data-source', {}),
      'src/config.ts': renderFile('service/config', {}),
      'src/lib/http.ts': renderFile('service/lib-http', {}),
      'src/main.ts': renderFile('service/main', { name }),
    },
  }
}
