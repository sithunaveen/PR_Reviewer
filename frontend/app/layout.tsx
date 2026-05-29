import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'PR Sheriff — Multi-Agent Code Review',
  description: 'GitAgent-powered PR review with Segregation of Duties enforcement',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
