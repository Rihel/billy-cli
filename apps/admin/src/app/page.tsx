import { Pages } from '@/lib/constants'
import { redirect } from 'next/navigation'

export default function Home() {
  redirect(Pages.dashboard)
}
