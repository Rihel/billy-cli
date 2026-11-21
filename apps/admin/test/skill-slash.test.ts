import { describe, expect, it } from 'vitest'
import {
  filterSkills,
  insertSkillToken,
  removeSkillToken,
  selectedSkillKeysOf,
  slashQueryOf,
} from '../src/app/(app)/(standalone)/main/ai/chat/skill-slash'

/**
 * 斜杠技能的文本口径：`/` 必须是 trim 后的第一个字符，选中后就是一个 `/技能名` 词元。
 * 没有富文本、没有额外 DTO —— 所以这套纯函数是前后端共同的事实来源。
 */
describe('slashQueryOf', () => {
  it('trim 后以 / 开头 → 返回查询词', () => {
    expect(slashQueryOf('/')).toBe('')
    expect(slashQueryOf('/des')).toBe('des')
    expect(slashQueryOf('   /des')).toBe('des')
  })

  it('打出空白 = 已经选完，菜单收起', () => {
    expect(slashQueryOf('/design-taste-frontend 帮我做个页面')).toBeNull()
  })

  it('/ 不在 trim 后的第一个字符 → 不触发', () => {
    expect(slashQueryOf('帮我做个页面 /des')).toBeNull()
    expect(slashQueryOf('')).toBeNull()
  })
})

describe('insertSkillToken', () => {
  it('把正在输入的 /query 换成 /技能名 + 一个空格', () => {
    expect(insertSkillToken('/des', 'design-taste-frontend')).toBe('/design-taste-frontend ')
  })

  it('保留用户已经写好的文字', () => {
    expect(insertSkillToken('  /des 帮我做个页面', 'design-taste-frontend')).toBe(
      '/design-taste-frontend 帮我做个页面',
    )
  })
})

describe('selectedSkillKeysOf', () => {
  const known = ['design-taste-frontend', 'humanizer-zh']

  it('只认已知技能的词元，按出现顺序去重', () => {
    expect(
      selectedSkillKeysOf('/humanizer-zh 用 /design-taste-frontend 做页 /humanizer-zh', known),
    ).toEqual(['humanizer-zh', 'design-taste-frontend'])
  })

  it('普通斜杠文本不算技能（/etc/passwd、/help）', () => {
    expect(selectedSkillKeysOf('/etc/passwd 和 /help', known)).toEqual([])
  })

  it('词元必须独占一个词：/design-taste-frontend-x 不算', () => {
    expect(selectedSkillKeysOf('/design-taste-frontend-x', known)).toEqual([])
  })
})

describe('removeSkillToken', () => {
  it('删掉词元并收掉多余空格', () => {
    expect(removeSkillToken('/design-taste-frontend 帮我做个页面', 'design-taste-frontend')).toBe(
      '帮我做个页面',
    )
    expect(removeSkillToken('/a /b 做页面', 'a')).toBe('/b 做页面')
  })
})

/** 只用到的四个字段；其余字段与选择逻辑无关，按 `never` 收口避免造一整条模型 */
const skill = (skillKey: string, title: string, enabled = true) =>
  ({ skillKey, title, description: `${skillKey} 的描述`, enabled }) as never

describe('filterSkills', () => {
  it('按 skillKey / 标题过滤、按名字排序、停用的不出现', () => {
    expect(
      filterSkills(
        [skill('zeta', '末位'), skill('alpha', '前端设计'), skill('beta', '停用', false)],
        '',
      ).map((item) => item.skillKey),
    ).toEqual(['alpha', 'zeta'])
    expect(filterSkills([skill('alpha', '前端设计')], '前端').map((i) => i.skillKey)).toEqual([
      'alpha',
    ])
  })
})
