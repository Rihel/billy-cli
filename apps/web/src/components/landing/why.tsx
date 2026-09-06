import { Reveal } from './reveal'

/** 理念：编辑化单列（border-t 分隔行），编号 + 标题 + 一句说明 */
const principles = [
  {
    no: '01',
    title: '规范，写进技能',
    desc: '工程的规范，怎么分层、怎么命名、怎么交付，都写进 Agent Skills。AI 动手前先读规范，交出来的代码自然合标准。',
  },
  {
    no: '02',
    title: '数据结构，只有一份',
    desc: '前后端共用的数据结构只定义一份，校验、存储、表单全部共用。改一个字段，处处生效。',
  },
  {
    no: '03',
    title: '能力，随时可换',
    desc: '数据库、缓存、队列、存储、推送，都封装成标准接口，业务只认接口不认实现。今天用这套，明天换那套，业务一行不改。',
  },
  {
    no: '04',
    title: '前端，拆成两套',
    desc: '用户端重表达，管理端重效率，拆成两个应用、隔离两套权限边界与依赖树，而非一个应用里用路由分组硬拼；共用同一份数据结构，改一个字段两边同时生效。',
  },
]

/** 价值：三列极简，无容器，靠留白呼吸 */
const values = [
  { title: '对开发者', desc: '样板交给模板，你只写业务。' },
  { title: '对 AI', desc: '交付符合规范的代码，而不是能跑的代码。' },
  { title: '对架构', desc: '分页、认证、错误、推送、监控，坑已替你踩完。' },
]

/**
 * 设计理念：非对称双栏。
 * 左栏：大留白中锚定「宣言竖排编号 01-04」与标题（sticky 于滚动区间）；
 * 右栏：四条编辑式思想（hairline 分隔） + 价值三列。
 */
export function Why() {
  return (
    <section id="why" className="scroll-mt-20 border-t border-zinc-200/70">
      <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:grid lg:grid-cols-[1fr_1.6fr] lg:gap-20 lg:px-8 lg:py-36">
        {/* 左栏：sticky 宣言 */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <Reveal>
            <p className="font-mono text-xs font-medium tracking-[0.18em] text-indigo-600 uppercase">
              设计理念
            </p>
            <h2 className="font-heading mt-5 text-4xl leading-[1.05] font-semibold tracking-tight text-zinc-950 sm:text-5xl">
              把答案
              <br />
              写进骨架
            </h2>
            <p className="mt-6 max-w-sm text-base leading-relaxed text-zinc-600">
              模板的职责，是把反复出现的工程难题先想清楚：接口怎么定、能力怎么复用、边界怎么划。
              想清楚的部分交给骨架，你只负责业务本身。
            </p>
          </Reveal>
        </div>

        {/* 右栏：编辑式条目 + 价值 */}
        <div className="mt-16 lg:mt-0">
          <div>
            {principles.map((principle, i) => (
              <Reveal key={principle.no} delay={i * 40}>
                <div className="grid gap-4 border-t border-zinc-200 py-9 md:grid-cols-[4.5rem_1fr] md:gap-10">
                  <span className="font-heading text-2xl font-semibold tracking-tight text-indigo-600/70">
                    {principle.no}
                  </span>
                  <div>
                    <h3 className="font-heading text-2xl font-semibold tracking-tight text-zinc-950">
                      {principle.title}
                    </h3>
                    <p className="mt-3 max-w-xl text-base leading-relaxed text-zinc-600">
                      {principle.desc}
                    </p>
                  </div>
                </div>
              </Reveal>
            ))}
            <div className="border-t border-zinc-200" aria-hidden />
          </div>

          {/* 价值三列 */}
          <div className="mt-14 grid grid-cols-1 gap-8 sm:grid-cols-3">
            {values.map((value, i) => (
              <Reveal key={value.title} delay={i * 40}>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-950">
                    {value.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600">
                    {value.desc}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
