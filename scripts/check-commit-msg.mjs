#!/usr/bin/env node
/**
 * commit-msg 钩子：校验提交信息符合「<类型>：<摘要>」中文规范。
 *
 * 用法：node scripts/check-commit-msg.mjs [消息文件路径]
 * - lefthook 会传入 {1}（Git 的消息文件）；缺省时回落到 git rev-parse --git-path COMMIT_EDITMSG。
 * - 跨平台：只用 node: 内置模块，路径由 git 提供，不拼分隔符；strip BOM 与 CRLF。
 * - Merge / Revert / fixup! / squash! 放行。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const TYPES = ['新增', '重构', '修复', '变更', '文档', '测试', '配置', '样式', '杂项']
const SEPARATOR = '：'
const MAX_SUMMARY = 50
const EXAMPLE = '配置：接入 oxlint 与 oxfmt'

function resolveMessagePath() {
  const arg = process.argv[2]
  if (arg) return arg.replace(/^['"]|['"]$/g, '')
  try {
    return execFileSync('git', ['rev-parse', '--git-path', 'COMMIT_EDITMSG'], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return '.git/COMMIT_EDITMSG'
  }
}

function fail(lines) {
  process.stderr.write(`\n✖ 提交信息不符合规范\n\n${lines.join('\n')}\n\n  示例：${EXAMPLE}\n\n`)
  process.exit(1)
}

let raw = ''
try {
  raw = readFileSync(resolveMessagePath(), 'utf8')
} catch {
  // 读不到消息文件时不拦提交（例如非标准 hook 调用），由 review 兜底
  process.exit(0)
}

const firstLine =
  raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#')) ?? ''

// Git 自动生成的消息放行
if (/^(Merge|Revert)\b/i.test(firstLine) || /^(fixup|squash)!/i.test(firstLine)) {
  process.exit(0)
}

const typePattern = new RegExp(`^(${TYPES.join('|')})${SEPARATOR}\\S`)
if (!typePattern.test(firstLine)) {
  fail([
    `  实际：${firstLine || '(空)'}`,
    `  规则：<类型>${SEPARATOR}<一句话摘要>，类型限定为 ${TYPES.join(' / ')}`,
    `  摘要要能独立看懂改了什么、为什么，不要用 update / fix / wip。`,
  ])
}

const summary = firstLine.slice(firstLine.indexOf(SEPARATOR) + 1).trim()
if (Array.from(summary).length > MAX_SUMMARY) {
  fail([`  实际：摘要 ${Array.from(summary).length} 字`, `  规则：摘要不超过 ${MAX_SUMMARY} 字`])
}
