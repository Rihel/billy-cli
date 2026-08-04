import { Effect, ManagedRuntime } from 'effect'
import { afterAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  DbService,
  RedisService,
  makeAppLayer,
  type AppConfigInput,
} from '../../src/index.js'

export const testConfig = {
  isDev: false,
  port: 9989,
  db: {
    url:
      process.env.TEST_DB_URL ??
      'postgresql://root:pg1234@localhost:15432/billy-cli',
  },
  redis: {
    url: process.env.TEST_REDIS_URL ?? 'redis://localhost:6380/0',
    keyPrefix: 'core-test:',
  },
  jwt: {
    secret: 'core-integration-test-secret',
    expiresIn: '1h',
  },
  auth: {
    resetPasswordTokenTtlMinutes: 30,
    passwordHashRounds: 4,
  },
  storage: {
    provider: 's3',
    region: 'us-east-1',
    bucket: 'core-integration-test',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:19000',
  },
  logger: {
    name: 'core-test',
    pretty: false,
  },
} satisfies AppConfigInput

export const testRuntime = ManagedRuntime.make(makeAppLayer(testConfig))

export const runEffect = testRuntime.runPromise

export const resetIntegrationState = () =>
  runEffect(
    Effect.gen(function* () {
      const db = yield* DbService
      const redis = yield* RedisService

      yield* db.query((raw) =>
        raw.execute(
          sql.raw('TRUNCATE TABLE users, todos RESTART IDENTITY CASCADE'),
        ),
      )
      yield* Effect.promise(() => redis.raw.flushdb().then(() => undefined))
    }),
  )

beforeEach(async () => {
  await resetIntegrationState()
})

afterAll(async () => {
  await testRuntime.dispose()
})
