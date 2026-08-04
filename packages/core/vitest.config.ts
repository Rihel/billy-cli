import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
})
