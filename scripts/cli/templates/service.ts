import type { Template } from '../types.js'
import { json, render, source } from './utils.js'

export function createServiceTemplate(name: string): Template {
  const data = { name }

  return {
    directory: 'apps',
    files: {
      'package.json': json({
        name: render('@app/<%= it.name %>', data),
        version: '0.1.0',
        description: '',
        private: true,
        type: 'module',
        scripts: {
          build: 'nest build',
          'build:docker': 'nest build',
          start: 'nest start',
          dev: 'nest start --watch',
          'start:debug': 'nest start --debug --watch',
          'start:prod': 'node dist/main',
        },
        dependencies: {
          '@nestjs-modules/ioredis': '^2.2.1',
          '@nestjs/bullmq': '^11.0.4',
          '@nestjs/common': '^11.0.1',
          '@nestjs/core': '^11.0.1',
          '@nestjs/jwt': '^11.0.2',
          '@nestjs/platform-express': '^11.0.1',
          '@nestjs/schedule': '^6.1.3',
          '@repo/db': 'workspace:*',
          '@repo/kits': 'workspace:*',
          '@repo/shared': 'workspace:*',
          '@types/bcrypt': '^6.0.0',
          '@types/jsonwebtoken': '^9.0.10',
          bcryptjs: '^3.0.3',
          bullmq: '^5.81.1',
          dayjs: '^1.11.21',
          dotenv: '^17.4.2',
          'drizzle-orm': '1.0.0-rc.4',
          express: '^5.2.1',
          ioredis: '^5.11.1',
          jsonwebtoken: '^9.0.3',
          lodash: '^4.18.1',
          ms: '^2.1.3',
          nanoid: '^6.0.0',
          pino: '^10.3.1',
          'pino-pretty': '^13.1.3',
          redis: '^6.1.0',
          'reflect-metadata': '^0.2.2',
          rxjs: '^7.8.1',
          'nest-zod': '^2.1.0',
          zod: '^4.4.3',
        },
        devDependencies: {
          '@eslint/eslintrc': '^3.2.0',
          '@eslint/js': '^9.18.0',
          '@nestjs/cli': '^11.0.0',
          '@nestjs/schematics': '^11.0.0',
          '@nestjs/testing': '^11.0.1',
          '@types/bcryptjs': '^3.0.0',
          '@types/express': '^5.0.6',
          '@types/jest': '^30.0.0',
          '@types/lodash': '^4.17.24',
          '@types/ms': '^2.1.0',
          '@types/node': '^24.0.0',
          '@types/supertest': '^7.0.0',
          globals: '^17.0.0',
          prettier: '^3.4.2',
          'source-map-support': '^0.5.21',
          supertest: '^7.0.0',
          'ts-jest': '^29.2.5',
          'ts-loader': '^9.5.2',
          'ts-node': '^10.9.2',
          'tsconfig-paths': '^4.2.0',
          typescript: '^6.0.0',
          'typescript-eslint': '^8.20.0',
        },
      }),
      'nest-cli.json': json({
        $schema: 'https://json.schemastore.org/nest-cli',
        collection: '@nestjs/schematics',
        sourceRoot: 'src',
        compilerOptions: { deleteOutDir: true },
      }),
      'tsconfig.json': json({
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          esModuleInterop: true,
          isolatedModules: true,
          declaration: true,
          removeComments: true,
          emitDecoratorMetadata: true,
          experimentalDecorators: true,
          strictPropertyInitialization: false,
          target: 'ES2023',
          types: ['node'],
          sourceMap: true,
          rootDir: 'src',
          outDir: 'dist',
          skipLibCheck: true,
          strict: true,
        },
      }),
      'src/root.module.ts': render(
        source`
          import { Module } from '@nestjs/common'
          import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core'
          import { LoggerModule, ResponseInterceptor, AppExceptionFilter } from '@repo/kits'
          import { appConfig } from './config.js'

          @Module({
            imports: [
              LoggerModule.forRoot({ pretty: appConfig.isDev }),
            ],
            providers: [
              { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
              { provide: APP_FILTER, useClass: AppExceptionFilter },
            ],
          })
          export class RootModule {}
        `,
        data,
      ),
      'src/config.ts': render(
        source`
          export const appConfig = {
            isDev: process.env.NODE_ENV !== 'production',
            port: Number(process.env.PORT ?? 9989),
            serviceName: '<%= it.name %>',
          }
        `,
        data,
      ),
      'src/main.ts': source`
        import 'dotenv/config'
        import { NestFactory } from '@nestjs/core'
        import { createLogger } from '@repo/shared/logger'
        import { appConfig } from './config.js'
        import { RootModule } from './root.module.js'

        async function bootstrap() {
          const logger = createLogger(appConfig.serviceName, appConfig.isDev)
          const app = await NestFactory.create(RootModule, { bufferLogs: true })
          app.useLogger(logger)
          app.flushLogs()
          app.enableCors()
          await app.listen(appConfig.port, () => {
            logger.info(\`服务已启动 http://localhost:\${appConfig.port}\`, appConfig)
          })
        }

        void bootstrap()
      `,
    },
  }
}
