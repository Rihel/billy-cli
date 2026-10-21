import type { z } from 'zod'

/** 字段路径 → 中文名 */
const fieldLabels: Record<string, string> = {
  email: '邮箱',
  password: '密码',
  oldPassword: '旧密码',
  newPassword: '新密码',
  realName: '姓名',
  avatar: '头像',
  title: '标题',
  description: '描述',
  completed: '完成状态',
  todoId: '待办ID',
  userId: '用户ID',
  key: '键',
  access: '访问权限',
  keyword: '关键词',
  page: '页码',
  size: '每页条数',
  orderBy: '排序字段',
  order: '排序方式',
  token: '令牌',
  name: '名称',
}

function fieldName(path: (string | number)[]): string {
  const last = path[path.length - 1]
  return typeof last === 'string' && fieldLabels[last]
    ? fieldLabels[last]
    : String(last)
}

/**
 * 将 ZodError.issues 解析为可读的中文错误摘要。
 * 多个字段错误用「；」拼接。
 */
export function parseZodIssues(issues: z.ZodIssue[]): string {
  return issues.map((issue) => translateOne(issue as any)).join('；')
}

function translateOne(issue: any): string {
  const label = fieldName(issue.path)

  switch (issue.code) {
    case 'invalid_type': {
      // Zod 4 起 `invalid_type` issue 不再提供 `received` 字段，实际类型只出现在 message 尾部
      // （固定格式：`Invalid input: expected <type>, received <type|undefined>`）；
      // 缺字段表现为 received undefined，据此区分「为空」与「类型不对」。
      const fromMessage = /received\s+(\S+)\s*$/.exec(String(issue.message ?? ''))?.[1]
      const received = issue.received ?? fromMessage
      if (received == null || received === 'undefined') {
        return `${label}不能为空`
      }
      return `${label}格式不正确（期望 ${issue.expected}，收到 ${received}）`
    }

    case 'invalid_format': {
      if (issue.format === 'email') return '邮箱格式不正确'
      return `${label}格式不正确`
    }

    case 'too_small': {
      // `origin` 区分「数字下限 / 数组条数 / 字符串长度」：数字说「个字符」会让人以为
      // 是在限制输入长度（分页的 size 超限就被报成"每页条数不能超过100个字符"）。
      if (issue.origin === 'number') {
        return `${label}不能小于${issue.minimum}`
      }
      if (issue.origin === 'array' || issue.origin === 'set') {
        return `${label}至少需要 ${issue.minimum} 项`
      }
      if (issue.minimum === 1 && issue.path.length > 0) {
        return `${label}不能为空`
      }
      if (typeof issue.minimum === 'number') {
        return `${label}至少需要${issue.minimum}个字符`
      }
      return `${label}不符合最小长度要求`
    }

    case 'too_big': {
      if (typeof issue.maximum === 'number') {
        if (issue.origin === 'number') return `${label}不能超过${issue.maximum}`
        if (issue.origin === 'array' || issue.origin === 'set') {
          return `${label}最多 ${issue.maximum} 项`
        }
        return `${label}不能超过${issue.maximum}个字符`
      }
      return `${label}不符合最大长度要求`
    }

    case 'invalid_value': {
      const valid = issue.values?.join?.('、') ?? ''
      return `${label}的值无效（可选值：${valid}）`
    }

    default:
      return issue.message
  }
}
