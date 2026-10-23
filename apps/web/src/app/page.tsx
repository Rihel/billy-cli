import { Header } from '@/components/landing/header'
import { Hero } from '@/components/landing/hero'
import { TechMarquee } from '@/components/landing/tech-marquee'
import { ProofStrip } from '@/components/landing/proof-strip'
import { AiSection } from '@/components/landing/ai-section'
import { Observability } from '@/components/landing/observability'
import { DesignShowcase } from '@/components/landing/design-showcase'
import { Maintainability } from '@/components/landing/maintainability'
import { QuickStart } from '@/components/landing/quick-start'
import { CtaSection } from '@/components/landing/cta-section'
import { Footer } from '@/components/landing/footer'
import { getWebAuthState } from '@/lib/auth-session'

export default async function HomePage() {
  // 登录态在服务端（httpOnly cookie）判定：首屏就渲染正确的账号入口，避免闪一下「登录/注册」
  const { authEnabled, user } = await getWebAuthState()

  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-brand/30">
      <Header user={user} authEnabled={authEnabled} />
      <main>
        <Hero user={user} authEnabled={authEnabled} />
        <ProofStrip />
        <TechMarquee />
        <AiSection />
        <Observability />
        <DesignShowcase />
        <Maintainability />
        <QuickStart />
        <CtaSection user={user} authEnabled={authEnabled} />
      </main>
      <Footer user={user} authEnabled={authEnabled} />
    </div>
  )
}
