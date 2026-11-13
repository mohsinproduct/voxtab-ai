/**
 * @file layout.tsx
  * @description Root layout: sticky top navbar with mobile sidebar drawer, max-w-4xl main container, desktop spotlight tracker, and responsive footer.
 */
import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import { Geist, Geist_Mono } from 'next/font/google';
import { HeaderBarContent, AppFooter, SpotlightTracker } from '@/components/ScreenHeader';
import { I18nProvider } from '@/lib/i18n';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
  display: 'swap',
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'VoxTab | Snap the Bill, Speak the Split',
  description:
    'Snap any receipt, say who had what in plain English, and get paid back with PayPal QR codes and shareable links.',
  keywords: ['bill splitter', 'receipt scanner', 'voice bill split', 'expense sharing', 'PayPal bill split'],
  authors: [{ name: 'Mohsin' }],
  icons: {
    icon: '/icon.svg',
    shortcut: '/icon.svg',
    apple: '/icon.svg',
  },
  openGraph: {
    title: 'VoxTab | Snap the Bill, Speak the Split',
    description: 'Snap any receipt, say who had what, and settle up instantly on PayPal.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#16131a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <I18nProvider>
          <SpotlightTracker/>
          <div className="min-h-screen flex flex-col">
            <header className="sticky top-0 z-40 glass">
              <Suspense fallback={<div className="h-16" />}>
                <HeaderBarContent/>
              </Suspense>
            </header>

            <main className="flex-1 w-full max-w-4xl mx-auto px-4 sm:px-6 md:px-8 pb-16">
              {children}
            </main>

            <Suspense fallback={null}>
              <AppFooter/>
            </Suspense>
          </div>
        </I18nProvider>
      </body>
    </html>
  );
}
