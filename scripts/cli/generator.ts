import { spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Template } from './types.js'

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 写入文件（自动创建父目录）。场景是全新目录写新文件，无需内存暂存 / 冲突检测。 */
async function writeFileRecursive(filePath: string, content: string) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
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

  // 主模块文件
  for (const [relativePath, content] of Object.entries(template.files)) {
    await writeFileRecursive(resolve(targetDirectory, relativePath), content)
  }

  // 额外文件（workspace 相对路径）
  if (template.extraFiles) {
    for (const [filePath, content] of Object.entries(template.extraFiles)) {
      await writeFileRecursive(resolve(workspaceRoot, filePath), content)
    }
  }

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