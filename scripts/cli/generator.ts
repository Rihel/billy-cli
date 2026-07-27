import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { create as createMemFs } from 'mem-fs'
import { create as createMemFsEditor } from 'mem-fs-editor'
import type { VinylMemFsEditorFile } from 'mem-fs-editor'
import type { Template } from './types.js'

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function generate(
  template: Template,
  name: string,
  workspaceRoot: string,
): Promise<string> {
  const targetDirectory = resolve(workspaceRoot, template.directory, name)
  if (await pathExists(targetDirectory)) {
    throw new Error(`目标目录已存在：${template.directory}/${name}`)
  }

  const store = createMemFs<VinylMemFsEditorFile>()
  const editor = createMemFsEditor(store)

  // 主模块文件
  for (const [relativePath, content] of Object.entries(template.files)) {
    editor.write(resolve(targetDirectory, relativePath), content)
  }

  // 额外文件（workspace 相对路径）
  if (template.extraFiles) {
    for (const [filePath, content] of Object.entries(template.extraFiles)) {
      editor.write(resolve(workspaceRoot, filePath), content)
    }
  }

  await editor.commit()

  return `${template.directory}/${name}`
}

export async function installDependencies(workspaceRoot: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('pnpm', ['install'], {
      cwd: workspaceRoot,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`pnpm install 退出，状态码：${code ?? 'unknown'}`))
    })
  })
}