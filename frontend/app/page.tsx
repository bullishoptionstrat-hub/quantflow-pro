import { redirect } from 'next/navigation'
// The landing page is the desk: the day's plan, risk and ticket on one screen.
// Sign-in still lands on /flow (see app/(auth)/login and middleware.ts).
export default function Home() { redirect('/desk') }
