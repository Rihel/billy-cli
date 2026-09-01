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

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white text-zinc-900 selection:bg-orange-200">
      <Header />
      <main>
        <Hero />
        <TechMarquee />
        <Why />
        <Features />
        <Choice />
        <AiSection />
        <Architecture />
        <QuickStart />
        <CtaSection />
      </main>
      <Footer />
    </div>
  )
}
