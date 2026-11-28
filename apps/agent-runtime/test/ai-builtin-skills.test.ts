import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SANDBOX_CDN_HOSTS } from '@repo/shared'
import { describe, expect, it } from 'vitest'
import { SkillLoader } from '../src/modules/ai/tools/skills/skill.loader.js'

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

/** 读技能目录下的参考文件（路径相对技能目录，如 `references/libraries.md`） */
const readBuiltinReference = async (name: string, path: string): Promise<string> => {
  const refs = await new SkillLoader(logger).resolve([name])
  const ref = refs[0]
  if (!ref) throw new Error(`内置技能不存在：${name}`)
  return readFileSync(join(ref.path, path), 'utf8')
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

  it('三级 CDN 与沙箱白名单一致，正文给边界与样式口径', async () => {
    const body = await readBuiltinSkill('html-page')

    for (const host of SANDBOX_CDN_HOSTS) {
      expect(body).toContain(host)
    }
    // 沙箱边界：白名单之外加载不出来；数据必须内联
    expect(body).toContain('一律加载不出来')
    expect(body).toContain('数据必须内联')
    // 样式口径：Tailwind **必须**用（工具类写主体布局 / 排版），`<style>` 不禁用、只做补位（动画 / 伪元素 /
    // 打印 / 库覆盖），不得整页绕开工具类；且**不用衬线字体**
    expect(body).toContain('@tailwindcss/browser')
    expect(body).toContain('必须用 Tailwind')
    expect(body).toContain('不是禁用')
    expect(body).toContain('补位')
    expect(body).toContain('font-serif')
    expect(body).toContain('不要衬线字体')
    // 交付流程：先 write-file 落 workspace，再 file-submit 到会话文件
    expect(body).toContain('write-file')
    expect(body).toContain('file-submit')

    // 三级兜底的**实际写法**放在参考文件里（正文只留规矩，不让每次加载都付模板的 token）
    const libraries = await readBuiltinReference('html-page', 'references/libraries.md')
    expect(libraries).toContain('document.write')
    expect(libraries).toContain('<\\/script>')
    expect(libraries).toContain('版本写死')
  })

  it('2D 绘制 / 动画 / 公式入口写死版本，并说清页面里没有内置 gsap', async () => {
    const libraries = await readBuiltinReference('html-page', 'references/libraries.md')

    // 三类库的入口：包名 + 版本写死，模型照抄即可；升版本时这三处要一起改
    for (const entry of ['@svgdotjs/svg.js@3.2.8', 'konva@10.9.1', 'gsap@3.15.1', 'katex@0.19.1']) {
      expect(libraries).toContain(entry)
    }
    // 内置 gsap 只给 `gsap` 围栏，`.html` 页面预览不注入脚本 —— 漏了这句模型会直接 gsap.to 报 not defined
    expect(libraries).toContain('没有内置 gsap')
    // KaTeX 只引 JS 不引 CSS 会退化成裸文本，所以 CSS 入口必须写出来
    expect(libraries).toContain('katex.min.css')
  })

  it('整页默认拆片段：流程、脚本与参考文件都在技能目录里', async () => {
    const body = await readBuiltinSkill('html-page')
    // 流程必须写到"跑脚本 → 交产物"这一步，否则模型只会拆不会合
    expect(body).toContain('scripts/build-html.mjs')
    expect(body).toContain('node scripts/build-html.mjs')
    expect(body).toContain('dist/index.html')
    expect(body).toContain('references/build-pipeline.md')
    // 没有 bash / node 时的退路：分片追加同一个文件
    expect(body).toContain('append-file')
    // 口径是**默认就拆**，不按体积判断（拆的是结构，不是大小）
    expect(body).toContain('默认就拆')
    expect(body).not.toContain('60KB')
    expect(body).not.toContain('小页面')
    // 取脚本只能靠 skill_read：技能目录路径随部署变，cp 在容器 / 远程 worker 里会失败
    expect(body).toContain('不要 `cp` 技能目录')
    // Tailwind 也必须版本写死 + 三级兜底（真实会话里模型写成 @4 单 CDN，断一家就丢栅格）
    expect(body).toContain('三级兜底')

    const ref = (await new SkillLoader(logger).resolve(['html-page']))[0]
    expect(ref).toBeDefined()
    // 构建脚本与参考文件是**资产**：`copy-assets` 要整树带进镜像，缺一个模型就读不到
    const script = join(ref!.path, 'scripts', 'build-html.mjs')
    expect(existsSync(script)).toBe(true)
    const source = readFileSync(script, 'utf8')
    expect(source).toContain('include:')
    expect(source).toContain('MAX_OUTPUT_BYTES')
    // 正文保持精简：细节都在 references/，文末索引按需读（技能每次加载都要付正文的 token）
    for (const file of ['build-pipeline', 'libraries', 'styles', 'sandbox', 'checklist']) {
      expect(body).toContain(`references/${file}.md`)
      expect(existsSync(join(ref!.path, 'references', `${file}.md`))).toBe(true)
    }
    expect(body.split('\n').length).toBeLessThan(150)
  })
})
