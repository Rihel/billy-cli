import { describe, expect, it, vi } from 'vitest'
import { BashExecutor } from '../src/capabilities/bash.executor.js'
import { FileExecutor } from '../src/capabilities/file.executor.js'
import {
  CredentialCandidatesExecutor,
  CredentialImportExecutor,
} from '../src/capabilities/credential.executor.js'
import { CredentialSaveExecutor } from '../src/capabilities/credential-save.executor.js'
import { indexCapabilities } from '../src/capabilities/invoke.controller.js'
import { buildWorkspaceService } from '../src/capabilities/manifest.js'

/**
 * 分发面与登记面的一致性（issue 5）。
 *
 * 修复前 `/invoke` 手写 tool → handler 映射，只认 bash 与 file：能力登记了、白名单也放了，
 * 调过来照样 `unsupported-tool`。现在两边读同一份 `@CapabilityDecl`，这条用例钉死"登记了就必须分得到"。
 */
const makeExecutors = () => {
  const runtime = { exec: vi.fn(), authorizeCommand: vi.fn(async () => null) }
  const locator = {
    workspaceIdOf: vi.fn(async () => null),
    forRequest: vi.fn(async () => null),
  }
  const importer = { candidates: vi.fn(async () => []), import: vi.fn() }
  const saver = { save: vi.fn() }
  return [
    new BashExecutor(runtime as never, locator as never),
    new FileExecutor(runtime as never, locator as never),
    new CredentialCandidatesExecutor(locator as never, importer as never),
    new CredentialImportExecutor(locator as never, importer as never),
    new CredentialSaveExecutor(locator as never, saver as never),
  ]
}

describe('invoke 分发面（issue 5）', () => {
  it('登记面里的每个能力都分得到（两处同源）', () => {
    const executors = makeExecutors()
    const registered = buildWorkspaceService(executors).capabilities.map((item) => item.tool)
    const dispatchable = indexCapabilities(executors)

    expect(registered.length).toBeGreaterThan(0)
    for (const tool of registered) expect(dispatchable.has(tool)).toBe(true)
  })

  it('credential 三件套在分发面里（修复前只分发 bash / file）', () => {
    const dispatchable = indexCapabilities(makeExecutors())
    for (const tool of ['credential-candidates', 'credential-import', 'credential-save']) {
      expect(dispatchable.has(tool)).toBe(true)
    }
  })

  it('未知工具不在索引里（控制器据此回 unsupported-tool）', () => {
    expect(indexCapabilities(makeExecutors()).has('not-a-tool')).toBe(false)
  })
})
