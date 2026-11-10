import { Reveal } from './reveal'

const derivation = [
  { label: '数据结构', detail: '@repo/shared 的 Zod schema，唯一一份', path: 'packages/shared/src/schema' },
  { label: '入参校验', detail: '@Body({ schema }) 由统一管道校验，controller 不写判断', path: 'common/http/zod-validation' },
  { label: '数据库实体', detail: 'TypeORM 实体与迁移由同一份字段生成', path: 'apps/server/src/database' },
  { label: '接口类型', detail: '全类型 SDK，前端调用有提示、改名即报错', path: 'packages/sdk' },
  { label: '后台表单', detail: 'ModalForm 按 schema 渲染，字段不另写一遍', path: '@repo/ui/modal-form' },
  { label: '列表列', detail: 'DataTable 列定义同样取自 schema', path: '@repo/ui/data-table' },
]

const checks = [
  { cmd: 'pnpm typecheck', detail: '五个包一起过类型' },
  { cmd: 'pnpm test', detail: '服务端与前端单测' },
  { cmd: 'pnpm check:inject', detail: '依赖注入写法全工程一致' },
  { cmd: 'pnpm check:mastra', detail: '适配器边界，业务不被框架渗透' },
  { cmd: 'pnpm check:ui', detail: '组件导出、设计系统、无硬编码颜色' },
]

const rules = [
  'shared 不依赖任何业务包',
  'kits 不引用 apps/*',
  'common 不依赖业务模块',
  'service / repository 不碰 HTTP',
]

/** 卖点四：高维护性。标题在上，下面两列：左边一处定义的传导链，右边检查清单与依赖方向。 */
export function Maintainability() {
  return (
    <section id="maintainability" className="scroll-mt-20 border-t border-border/70 bg-muted/60">
      <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8 lg:py-32">
        <Reveal>
          <h2 className="font-heading max-w-2xl text-4xl leading-[1.05] font-semibold tracking-tight text-foreground sm:text-5xl">
            改一处，
            <br />
            处处对得上
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground">
            字段定义一次，校验、实体、接口类型、表单、列表都跟着走；依赖方向单向，检查脚本在提交前拦住走样。
            27 个 Agent Skills 指向仓库真实文件，AI 改代码时读到的就是这套约束，不是一份过时的说明书。
          </p>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-12 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16">
          {/* 左：一处定义，六处生效 */}
          <div>
            <h3 className="text-base font-medium text-foreground">一处定义，六处生效</h3>
            <div className="mt-4">
              {derivation.map((item) => (
                <Reveal key={item.label}>
                  <div className="grid gap-1 border-t border-border py-4 sm:grid-cols-[6rem_1fr] sm:gap-6">
                    <p className="text-sm text-foreground">{item.label}</p>
                    <div>
                      <p className="text-sm leading-relaxed text-muted-foreground">{item.detail}</p>
                      <code className="mt-1 block font-mono text-[11px] text-muted-foreground/80">
                        {item.path}
                      </code>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>

          {/* 右：检查与依赖方向 */}
          <div>
            <h3 className="text-base font-medium text-foreground">五道检查，过了才算做完</h3>
            <div className="mt-4">
              {checks.map((check) => (
                <Reveal key={check.cmd}>
                  <div className="border-t border-border py-3">
                    <code className="font-mono text-[11.5px] text-foreground">{check.cmd}</code>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{check.detail}</p>
                  </div>
                </Reveal>
              ))}
            </div>

            <h3 className="mt-10 text-base font-medium text-foreground">依赖方向不可逆</h3>
            <div className="mt-4 flex flex-wrap gap-2">
              {rules.map((rule) => (
                <code
                  key={rule}
                  className="rounded-lg border border-border bg-card px-2.5 py-1 font-mono text-xs text-muted-foreground"
                >
                  {rule}
                </code>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
