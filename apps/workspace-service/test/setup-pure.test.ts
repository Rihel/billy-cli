import { describe, expect, it } from 'vitest'
import type { WorkspaceSetupPackage } from '@repo/shared'
import {
  installCommandOf,
  mergeSetupPackages,
  renderInjectRules,
  setupHashOf,
} from '../src/workspace/setup-pure.js'

/**
 * 初始化阶段的纯函数（`docs/design/workspace-cli-credentials.md` §6.2 / §6.3 / §6.4.3）。
 *
 * 这里不碰容器：安装命令怎么拼、注入模板怎么渲染、幂等哈希覆盖什么，全部可断言。
 */

const pkg = (over: Partial<WorkspaceSetupPackage> = {}): WorkspaceSetupPackage => ({
  manager: 'npm',
  spec: '@larksuite/cli@1.2.3',
  verify: 'lark --version',
  ...over,
})

describe('安装命令：声明 → shell', () => {
  it('五种管理器各拼一条命令', () => {
    expect(installCommandOf(pkg())).toBe('npm install -g --no-fund --no-audit @larksuite/cli@1.2.3')
    expect(installCommandOf(pkg({ manager: 'pnpm', spec: 'vercel@39.0.0' }))).toContain(
      'pnpm add -g vercel@39.0.0',
    )
    expect(installCommandOf(pkg({ manager: 'apt', spec: 'redis-tools' }))).toContain(
      'apt-get install -y --no-install-recommends redis-tools',
    )
    expect(installCommandOf(pkg({ manager: 'pip', spec: 'httpie==3.2.4' }))).toContain(
      'pip install --no-input httpie==3.2.4',
    )
    expect(installCommandOf(pkg({ manager: 'uv', spec: 'ruff==0.9.0' }))).toContain(
      'uv tool install ruff==0.9.0',
    )
  })
})

describe('清单合并：默认清单 + 工作区追加', () => {
  it('同一 manager+spec 只保留一份（追加项不重复装）', () => {
    const base = [pkg({ spec: 'a@1' }), pkg({ spec: 'b@1', manager: 'apt', verify: 'b -v' })]
    const extra = [pkg({ spec: 'a@1' }), pkg({ spec: 'c@1' })]
    expect(mergeSetupPackages(base, extra).map((item) => item.spec)).toEqual(['a@1', 'b@1', 'c@1'])
  })
})

describe('幂等哈希：只覆盖声明，不覆盖凭据', () => {
  const input = {
    setupId: 'setup_1',
    packages: [pkg()],
    skills: [
      { key: 'b-skill', contentHash: 'h2' },
      { key: 'a-skill', contentHash: 'h1' },
    ],
  }

  it('技能顺序不影响结果（稳定）', () => {
    const a = setupHashOf(input)
    const b = setupHashOf({ ...input, skills: [...input.skills].reverse() })
    expect(a).toBe(b)
    expect(a).toHaveLength(16)
  })

  it('换包或换技能内容 → 哈希变化（该重装就重装）', () => {
    const base = setupHashOf(input)
    expect(setupHashOf({ ...input, packages: [pkg({ spec: 'a@2' })] })).not.toBe(base)
    expect(
      setupHashOf({ ...input, skills: [{ key: 'a-skill', contentHash: 'changed' }] }),
    ).not.toBe(base)
  })
})

describe('注入渲染：文件 / 环境变量', () => {
  const values = {
    config: { host: 'db.internal', port: 3306, username: 'root' },
    secret: { password: 'p@ss word' },
  }

  it('文件模板按 ${config.x} / ${secret.x} 渲染', () => {
    const result = renderInjectRules(
      [
        {
          type: 'file',
          path: '~/.my.cnf',
          template:
            '[client]\nhost=${config.host}\nport=${config.port}\npassword=${secret.password}\n',
        },
      ],
      values,
    )
    expect(result.errors).toEqual([])
    expect(result.files[0]).toEqual({
      path: '~/.my.cnf',
      content: '[client]\nhost=db.internal\nport=3306\npassword=p@ss word\n',
    })
  })

  it('模板引用不存在的字段 → 报错且不产出文件（不写半截凭据）', () => {
    const result = renderInjectRules(
      [{ type: 'file', path: '~/.x', template: 'token=${secret.nope}' }],
      values,
    )
    expect(result.files).toEqual([])
    expect(result.errors[0]).toContain('secret.nope')
  })

  it('env 规则：单字段凭据可省略 field；多字段不猜就报错', () => {
    expect(renderInjectRules([{ type: 'env', name: 'PASSWORD' }], values).env).toEqual({
      PASSWORD: 'p@ss word',
    })

    const ambiguous = renderInjectRules([{ type: 'env', name: 'TOKEN' }], {
      config: {},
      secret: { a: '1', b: '2' },
    })
    expect(ambiguous.env).toEqual({})
    expect(ambiguous.errors[0]).toContain('未指定字段')

    const explicit = renderInjectRules([{ type: 'env', name: 'TOKEN', field: 'b' }], {
      config: {},
      secret: { a: '1', b: '2' },
    })
    expect(explicit.env).toEqual({ TOKEN: '2' })
  })
})
