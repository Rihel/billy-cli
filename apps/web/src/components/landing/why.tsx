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
    desc: '用户端重表达，管理端重效率，拆成两个应用各自用最顺手的工具；共用同一份数据结构，改一个字段两边同时生效。',
  },
]

/** 价值：三列极简，无容器，靠留白呼吸 */
const values = [
  { title: '对开发者', desc: '样板交给模板，你只写业务。' },
  { title: '对 AI', desc: '交付符合规范的代码，而不是能跑的代码。' },
  { title: '对架构', desc: '分页、认证、错误、推送、监控，坑已替你踩完。' },
]

/**
 * 设计理念：一句宣言 + 四个设计决策 + 价值落点。
 * 用词平实（规范 / 数据结构 / 能力），不堆术语；立场克制，让读者自己得出结论。
 */
export function Why() {
  return (
    <section id="why" className="scroll-mt-20">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        {/* 宣言头部：垂直堆叠 */}
        <Reveal>
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl">
            把答案写进骨架
          </h2>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-zinc-600">
            模板的职责，是把反复出现的工程难题先想清楚：接口怎么定、能力怎么复用、边界怎么划。
            想清楚的部分交给骨架，你只负责业务本身。
          </p>
        </Reveal>

        {/* 四个设计决策：编辑化列表 */}
        <div className="mt-16">
          {principles.map((principle, i) => (
            <Reveal key={principle.no} delay={i * 40}>
              <div className="grid gap-3 border-t border-zinc-200 py-8 md:grid-cols-[5rem_1fr_1.4fr] md:items-baseline md:gap-8">
                <span className="font-mono text-sm text-orange-600">{principle.no}</span>
                <h3 className="text-lg font-semibold tracking-tight text-zinc-950 md:text-xl">
                  {principle.title}
                </h3>
                <p className="text-sm leading-relaxed text-zinc-600">{principle.desc}</p>
              </div>
            </Reveal>
          ))}
          <div className="border-t border-zinc-200" aria-hidden />
        </div>

        {/* 价值：三列极简 */}
        <div className="mt-16 grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-8">
          {values.map((value, i) => (
            <Reveal key={value.title} delay={i * 40}>
              <div>
                <h3 className="text-sm font-medium text-zinc-950">{value.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-600">{value.desc}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
