import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/lib/auth-provider';
import { AuthGuard } from '@/components/AuthGuard';
import { Nav } from '@/components/Nav';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';
import { SeedBootstrap } from '@/components/SeedBootstrap';
import { ScheduleCursorHealer } from '@/components/ScheduleCursorHealer';
import { LegacyDefaultAssistanceMigrator } from '@/components/LegacyDefaultAssistanceMigrator';
import { SyncConflictFloodCleanup } from '@/components/SyncConflictFloodCleanup';
import { MondayDigest } from '@/components/MondayDigest';
import { KeepScreenOn } from '@/components/KeepScreenOn';
import { PullToRefresh } from '@/components/PullToRefresh';
import { OnboardingMount } from '@/components/OnboardingWizard';
import { QuickJumpPalette } from '@/components/QuickJumpPalette';
import { ChatFab } from '@/components/ChatFab';
import './globals.css';

export const metadata: Metadata = {
  title: 'Wendler 5/3/1',
  description: 'Personal 5/3/1 training app',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: '5/3/1',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  themeColor: '#0b0b0c',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-bg"
        >
          Skip to content
        </a>
        <PullToRefresh />
        <AuthProvider>
          <AuthGuard>
            <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-4 md:pt-20">
              {children}
            </main>
            <Nav />
            <OnboardingMount />
            <QuickJumpPalette />
            <ChatFab />
          </AuthGuard>
        </AuthProvider>
        <ServiceWorkerRegister />
        <SeedBootstrap />
        <ScheduleCursorHealer />
        <LegacyDefaultAssistanceMigrator />
        <SyncConflictFloodCleanup />
        <MondayDigest />
        <KeepScreenOn />
      </body>
    </html>
  );
}
