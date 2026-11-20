import { describe, expect, it } from 'vitest'
import {
  CREDENTIAL_TEMPLATES,
  buildCredentialValuesSchema,
  credentialAadOf,
  credentialHintOf,
  credentialTemplateOf,
  splitCredentialValues,
} from '../src/credential'

/**
 * 字段模板驱动的一切（`docs/design/workspace-cli-credentials.md` §6.4.1.1）。
 *
 * 要钉的是"模板是单一事实源"：校验、明文/密文拆分、提示值全部从模板派生，
 * 代码里不出现具体字段名。
 */

const mysql = credentialTemplateOf('mysql')
const tencent = credentialTemplateOf('tencent-cloud')
const redis = credentialTemplateOf('redis')

/** 模板是数据，取不到就该立刻失败（而不是让测试跑成"空断言"） */
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('模板不存在')
  return value
}

describe('内置模板自身的一致性', () => {
  it('五个 provider 都在，字段名唯一、必填字段有中文标签', () => {
    const providers = CREDENTIAL_TEMPLATES.map((template) => template.provider)
    expect(providers).toEqual(['github', 'lark', 'mysql', 'redis', 'tencent-cloud'])

    for (const template of CREDENTIAL_TEMPLATES) {
      const keys = template.fields.map((field) => field.key)
      expect(new Set(keys).size).toBe(keys.length)
      for (const field of template.fields) {
        expect(field.label.length).toBeGreaterThan(0)
      }
    }
  })

  it('hintField 必须指向真实存在的字段（写错只会在运行时才炸）', () => {
    for (const template of CREDENTIAL_TEMPLATES) {
      if (!template.hintField) continue
      expect(template.fields.map((field) => field.key)).toContain(template.hintField)
    }
  })

  it('oauth 模板的字段固定为 accessToken / refreshToken / expiresAt / scope', () => {
    expect(must(credentialTemplateOf('lark')).fields.map((field) => field.key)).toEqual([
      'accessToken',
      'refreshToken',
      'expiresAt',
      'scope',
    ])
  })

  it('显式 template 优先、缺省回落 provider 同名模板；未知 provider 返回 undefined', () => {
    expect(credentialTemplateOf('mysql', 'mysql')?.provider).toBe('mysql')
    expect(credentialTemplateOf('mysql', null)?.provider).toBe('mysql')
    expect(credentialTemplateOf('unknown-cli')).toBeUndefined()
  })
})

describe('校验：规则全部来自模板', () => {
  it('合法输入通过，表单传来的字符串端口被 coerce 成数字', () => {
    const schema = buildCredentialValuesSchema(must(mysql))
    const parsed = schema.parse({
      host: ' 10.0.0.8 ',
      port: '3306',
      database: 'biz',
      username: 'root',
      password: 'p@ss',
    })

    expect(parsed.port).toBe(3306)
    expect(parsed.host).toBe('10.0.0.8')
  })

  it('缺必填字段 → 中文提示（不出现英文 zod 报错）', () => {
    const schema = buildCredentialValuesSchema(must(mysql))
    const result = schema.safeParse({ host: '10.0.0.8' })

    expect(result.success).toBe(false)
    const messages = result.error?.issues.map((issue) => issue.message) ?? []
    expect(messages.join('；')).toMatch(/请填写/)
  })

  it('选填字段留空视为未提供（Redis 无密码实例）', () => {
    const schema = buildCredentialValuesSchema(must(redis))
    const parsed = schema.parse({ host: 'cache', port: 6379, db: 0, password: '' })

    expect(parsed.password).toBeUndefined()
    const split = splitCredentialValues(must(redis), parsed)
    expect(split.secret).toEqual({})
  })
})

describe('拆分与提示值', () => {
  it('config / secret 按模板的 scope 分流，未声明的键被 schema 丢掉', () => {
    const schema = buildCredentialValuesSchema(must(tencent))
    const parsed = schema.parse({
      region: 'ap-shanghai',
      secretId: 'AKIDabcdefgh1234',
      secretKey: 'super-secret',
      extra: 'ignored',
    })
    const split = splitCredentialValues(must(tencent), parsed)

    expect(split.config).toEqual({ region: 'ap-shanghai' })
    expect(split.secret).toEqual({ secretId: 'AKIDabcdefgh1234', secretKey: 'super-secret' })
    expect(JSON.stringify(split.config)).not.toContain('super-secret')
  })

  it('云厂商取密钥尾部提示；数据库取用户名；没有可用值时为 null', () => {
    expect(
      credentialHintOf(
        must(tencent),
        { region: 'ap-guangzhou' },
        { secretId: 'AKIDabcdefgh1234', secretKey: 'x' },
      ),
    ).toBe('AKID…1234')

    expect(
      credentialHintOf(
        must(mysql),
        { host: 'h', port: 3306, database: 'd', username: 'root' },
        {
          password: 'x',
        },
      ),
    ).toBe('root')

    expect(credentialHintOf(must(redis), { host: 'cache', port: 6379, db: 0 }, {})).toBe('cache')
  })

  it('有默认值的必填字段可以不填（端口 / 库号），默认值参与校验', () => {
    const schema = buildCredentialValuesSchema(must(redis))
    const parsed = schema.parse({ host: 'cache' })
    expect(parsed).toMatchObject({ host: 'cache', port: 6379, db: 0 })
  })
})

describe('AAD：把密文与归属绑定', () => {
  it('格式固定为 id|owner_type:owner_id|provider|template', () => {
    expect(
      credentialAadOf({
        id: 'cred_1',
        ownerType: 'user',
        ownerId: 'u_1',
        provider: 'mysql',
        template: 'mysql',
      }),
    ).toBe('cred_1|user:u_1|mysql|mysql')
  })
})
