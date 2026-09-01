/** 竞品调研数据（2026-09-02 调研，数据以 GitHub 为准，star 与价格会随时间变化） */
export type Competitor = {
  name: string
  /** 官网或 GitHub 仓库链接 */
  url: string
  /** 区域：海外 / 国内 */
  region: '海外' | '国内'
  /** true = 收费商业，false = 免费开源 */
  paid: boolean
  /** 是否全栈（提供「前端 + 后端」的完整应用骨架） */
  isFullstack: boolean
  /** 形态一句话 */
  form: string
  /** 是否有 AI 能力 */
  ai: boolean
  /** AI 能力简述 */
  aiNote: string
  /** star 数或价格 */
  metric: string
  /** 维护状态 */
  maintenance: string
  /** issues 处理情况 */
  issues: string
  /** 真实案例 */
  cases: string
  /** 一句话定位 */
  summary: string
}

export const competitors: Competitor[] = [
  // ============ 海外 · 免费开源 ============
  {
    name: 'Open SaaS',
    url: 'https://github.com/wasp-lang/open-saas',
    region: '海外',
    paid: false,
    isFullstack: true,
    form: 'Wasp 框架（React + Node + Prisma）',
    ai: true,
    aiNote: 'AI-ready：AGENTS.md + skills + Claude Code plugin',
    metric: '约 1.6 万 star',
    maintenance: '活跃',
    issues: 'open 103',
    cases: 'Wasp 官方 SaaS starter',
    summary: 'Wasp 官方免费 SaaS 起步套件，AI-ready 且功能全，但绑定 Wasp 声明式 DSL、单体 SaaS 形态。',
  },
  {
    name: 'Ixartz SaaS-Boilerplate',
    url: 'https://github.com/ixartz/SaaS-Boilerplate',
    region: '海外',
    paid: false,
    isFullstack: true,
    form: 'Next.js 全栈',
    ai: false,
    aiNote: '无',
    metric: '约 7400 star',
    maintenance: '活跃',
    issues: 'open 5',
    cases: '未具名',
    summary: '免费 Next.js 全栈 SaaS 模板，多租户 / 权限 / i18n 齐全，但无 AI 能力。',
  },
  // ============ 海外 · 收费商业 ============
  {
    name: 'Makerkit',
    url: 'https://makerkit.dev',
    region: '海外',
    paid: true,
    isFullstack: true,
    form: 'Turborepo monorepo SaaS 模板',
    ai: true,
    aiNote: 'AGENTS.md + 自研 MCP Server（56+ 工具）',
    metric: '$349 买断',
    maintenance: '非常活跃',
    issues: '私有仓库',
    cases: 'Caretrics、watchthis.page',
    summary: 'B2B 多租户 SaaS 成品模板，AI 原生且案例扎实，但闭源付费、垂直 SaaS。',
  },
  {
    name: 'Gravity',
    url: 'https://usegravity.app',
    region: '海外',
    paid: true,
    isFullstack: true,
    form: '全栈 SaaS 模板',
    ai: true,
    aiNote: 'CLAUDE.md / AGENTS.md / IDE rules',
    metric: '$199 起 · 续费 $195/年',
    maintenance: '活跃',
    issues: '私有仓库',
    cases: '有证言（CodeTutor 等）',
    summary: 'Node + React + RN SaaS 样板，AI 规则齐全，垂直 SaaS、付费。',
  },
  {
    name: 'ShipFast',
    url: 'https://shipfa.st',
    region: '海外',
    paid: true,
    isFullstack: true,
    form: '单体 Next.js SaaS 模板',
    ai: false,
    aiNote: '仅 GPT 提示词 + OpenAI 集成（弱）',
    metric: '$199 起',
    maintenance: '更新趋缓',
    issues: '仓库已私有化',
    cases: '283 个 Stripe 验证项目',
    summary: '单人 SaaS MVP 样板，案例最多，但 AI 非原生、更新趋缓。',
  },
  {
    name: 'Supastarter',
    url: 'https://supastarter.dev',
    region: '海外',
    paid: true,
    isFullstack: true,
    form: 'Next.js / Nuxt / SvelteKit',
    ai: false,
    aiNote: '未查到（官方未宣传 AI 能力）',
    metric: '$299 起',
    maintenance: '商业维护',
    issues: '闭源',
    cases: '未具名',
    summary: '多框架 B2B SaaS 模板，多租户 / i18n / RBAC 见长，付费闭源。',
  },
  // ============ 国内 · 全栈脚手架 ============
  {
    name: 'yudao-cloud',
    url: 'https://github.com/YunaiV/yudao-cloud',
    region: '国内',
    paid: false,
    isFullstack: true,
    form: 'Java Spring Cloud 微服务 + Vue3',
    ai: true,
    aiNote: '内置 AI 大模型业务模块（LLM 对话 / 生图），非 agent 工作流',
    metric: '约 1.9 万 star',
    maintenance: '活跃',
    issues: 'issues 几乎全部关闭',
    cases: '未具名（自称头部企业验证）',
    summary: '国产 Java 微服务全栈平台，功能极全；AI 是内嵌大模型模块，非 AI 原生开发。',
  },
  {
    name: 'RuoYi',
    url: 'https://github.com/yangzongzhuan/RuoYi',
    region: '国内',
    paid: false,
    isFullstack: true,
    form: 'Java Spring Boot + Thymeleaf/jQuery',
    ai: false,
    aiNote: '无，仅有数据库表生成 CRUD 的模板生成器',
    metric: '约 8500 star',
    maintenance: '活跃',
    issues: 'open 18，关闭率高',
    cases: '大量二次开发项目',
    summary: '国产最经典 Java 单体后台脚手架，服务端渲染，无 AI 能力。',
  },
  // ============ 国内 · 前端模板 ============
  {
    name: 'ant-design-pro',
    url: 'https://github.com/ant-design/ant-design-pro',
    region: '国内',
    paid: false,
    isFullstack: false,
    form: 'React + antd 前端',
    ai: true,
    aiNote: 'CLAUDE.md + 2 个 Claude Code skills（/antd、/pro-upgrade）',
    metric: '约 3.9 万 star',
    maintenance: '活跃',
    issues: 'open 42 / closed 9799',
    cases: '蚂蚁集团出品',
    summary: '蚂蚁官方 React 中台前端模板，有 AI skills，但纯前端、无后端。',
  },
  {
    name: 'vue-vben-admin',
    url: 'https://github.com/vbenjs/vue-vben-admin',
    region: '国内',
    paid: false,
    isFullstack: false,
    form: 'Vue3 + TS 前端',
    ai: false,
    aiNote: '无',
    metric: '约 3.3 万 star',
    maintenance: '活跃',
    issues: 'open 50 / closed 4098',
    cases: '未具名',
    summary: '国内最流行 Vue3 前端模板，纯前端（自带 Mock），无 AI 能力。',
  },
  {
    name: 'vue-element-admin',
    url: 'https://github.com/PanJiaChen/vue-element-admin',
    region: '国内',
    paid: false,
    isFullstack: false,
    form: 'Vue2 前端',
    ai: false,
    aiNote: '无',
    metric: '约 9 万 star',
    maintenance: '已停止维护',
    issues: 'open 1256 / closed 2357',
    cases: '大量内部管理系统使用',
    summary: '国内最流行 Vue2 前端模板，纯前端无后端，已停更。',
  },
]
