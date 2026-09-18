import { Header } from '@/components/landing/header'
import { Hero } from '@/components/landing/hero'
import { TechMarquee } from '@/components/landing/tech-marquee'
import { Why } from '@/components/landing/why'
import { Features } from '@/components/landing/features'
import { Choice } from '@/components/landing/choice'
import { AiSection } from '@/components/landing/ai-section'
import { Architecture } from '@/components/landing/architecture'
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
        <TechMarquee />
        <Why />
        <Features />
        <Choice />
        <AiSection />
        <Architecture />
        <QuickStart />
        <CtaSection user={user} authEnabled={authEnabled} />
      </main>
      <Footer user={user} authEnabled={authEnabled} />
    </div>
  )
}
