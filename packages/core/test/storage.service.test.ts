import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { StorageService } from '../src/infra/storage/storage.service.js'
import { runEffect } from './helpers/integration.js'

describe('StorageService with real MinIO', () => {
  it('uploads, reads, downloads, and removes a real object', async () => {
    const key = `tests/${Date.now()}-object.txt`
    const upload = await runEffect(
      Effect.flatMap(StorageService, (storage) =>
        storage.getPresignedUrl({ key }),
      ),
    )

    const uploaded = await fetch(upload.url, {
      method: 'PUT',
      body: 'real object content',
    })
    expect(uploaded.ok).toBe(true)

    const object = await runEffect(
      Effect.flatMap(StorageService, (storage) => storage.getObject(key)),
    )
    expect(object.toString()).toBe('real object content')

    const download = await runEffect(
      Effect.flatMap(StorageService, (storage) => storage.getDownloadUrl(key)),
    )
    expect(await (await fetch(download.url)).text()).toBe('real object content')

    await runEffect(
      Effect.flatMap(StorageService, (storage) => storage.removeObject(key)),
    )
  })
})
