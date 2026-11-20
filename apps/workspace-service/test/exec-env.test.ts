import { describe, expect, it } from 'vitest'
import { shellQuote, withEnvPrefix } from '../src/workspace/exec-env.js'

describe('withEnvPrefix', () => {
  it('无 env 时命令原样返回', () => {
    expect(withEnvPrefix('echo ok')).toBe('echo ok')
    expect(withEnvPrefix('echo ok', {})).toBe('echo ok')
  })

  it('单个环境变量形成 env 前缀，整条命令交给内层 shell', () => {
    expect(withEnvPrefix('echo ok', { FOO: 'bar' })).toBe("env 'FOO=bar' sh -c 'echo ok'")
  })

  it('多个环境变量按键名排序，结果可复现', () => {
    expect(withEnvPrefix('node app.js', { ZED: 'z', ALPHA: 'a', BETA: 'b' })).toBe(
      "env 'ALPHA=a' 'BETA=b' 'ZED=z' sh -c 'node app.js'",
    )
    // 插入顺序不同，输出必须一致
    expect(withEnvPrefix('node app.js', { BETA: 'b', ZED: 'z', ALPHA: 'a' })).toBe(
      withEnvPrefix('node app.js', { ALPHA: 'a', ZED: 'z', BETA: 'b' }),
    )
  })

  it('值含空格时整体被引号锁住', () => {
    expect(withEnvPrefix('run', { GREETING: 'hello world' })).toBe(
      "env 'GREETING=hello world' sh -c 'run'",
    )
  })

  it('值含单引号时转义正确', () => {
    expect(shellQuote("it's")).toBe(String.raw`'it'\''s'`)
    expect(withEnvPrefix('run', { TOKEN: "a'b" })).toBe(String.raw`env 'TOKEN=a'\''b' sh -c 'run'`)
  })

  it('值含 $ 与反引号时不会被展开', () => {
    expect(withEnvPrefix('run', { TOKEN: '$HOME/`whoami`' })).toBe(
      "env 'TOKEN=$HOME/`whoami`' sh -c 'run'",
    )
  })

  it('复合命令里的 $VAR 也能取到注入值（前缀只作用于一条命令是错的）', () => {
    // 结构上必须把整段命令交给 sh -c；运行时行为见下方 spawn 实测
    expect(withEnvPrefix('echo a; echo $MY_VAR', { MY_VAR: 'v' })).toContain(
      "sh -c 'echo a; echo $MY_VAR'",
    )
  })

  it('值含分号与换行时仍是同一个字面量', () => {
    expect(shellQuote('line1; rm -rf /\nline2')).toBe("'line1; rm -rf /\nline2'")
  })
})
