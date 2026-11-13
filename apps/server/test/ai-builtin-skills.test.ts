import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SANDBOX_CDN_HOSTS } from '@repo/shared'
import { describe, expect, it } from 'vitest'
import { SkillLoader } from '../src/modules/ai/core/skills/skill.loader.js'

/**
 * 随包内置技能（`core/skills/catalog/`）的守卫。
 *
 * 钉两件事：
 * 1. **能被发现** —— catalog 是严格根（校验不过启动即失败），所以"列得出来"本身就是校验通过；
 * 2. `html-page` 里的 CDN 必须与沙箱 CSP 用的白名单**同一份**（`SANDBOX_CDN_HOSTS`）：
 *    提示词只给一句白名单、地址模板在技能里，两边漂移的后果是"教了、拦了"，页面一片空白且不报错。
 */

const logger = {
  log: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

const readBuiltinSkill = async (name: string): Promise<string> => {
  const refs = await new SkillLoader(logger).resolve([name])
  const ref = refs[0]
  if (!ref) throw new Error(`内置技能不存在：${name}`)
  return readFileSync(join(ref.path, 'SKILL.md'), 'utf8')
}

describe('内置技能：html-page', () => {
  it('随包目录能被发现，description 写清"什么时候用"', async () => {
    const skills = await new SkillLoader(logger).list()
    const skill = skills.find((item) => item.name === 'html-page')
    expect(skill).toBeDefined()
    // description 是模型判断"要不要加载"的唯一依据，不能写成内容摘要：
    // 用户口径是「只要是写 HTML 都要看」，所以触发面要覆盖围栏，而不只是 .html 文件
    expect(skill?.description).toContain('只要产出 HTML')
    expect(skill?.description).toContain('围栏')
    expect(skill?.description).toContain('三级 CDN')
  })

  it('三级 CDN 与沙箱白名单一致，且写法要点与交付流程齐全', async () => {
    const body = await readBuiltinSkill('html-page')

    for (const host of SANDBOX_CDN_HOSTS) {
      expect(body).toContain(host)
    }
    // 三级兜底的实际写法（模型最容易写错的两处：不写兜底、`</script>` 不转义）
    expect(body).toContain('document.write')
    expect(body).toContain('<\\/script>')
    expect(body).toContain('版本写死')
    // 沙箱边界：白名单之外加载不出来；数据必须内联
    expect(body).toContain('一律加载不出来')
    expect(body).toContain('数据必须内联')
    // 样式口径：用 Tailwind 浏览器版（版本写死、三级兜底），且**不用衬线字体**
    expect(body).toContain('@tailwindcss/browser')
    expect(body).toContain('font-serif')
    expect(body).toContain('不要衬线字体')
    // 交付流程：先 write-file 落 workspace，再 file-submit 到会话文件
    expect(body).toContain('write-file')
    expect(body).toContain('file-submit')
  })
})
