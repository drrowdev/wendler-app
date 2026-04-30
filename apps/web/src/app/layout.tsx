import type { Metadata, Viewport } from 'next';
import { Nav } from '@/components/Nav';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';
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
        <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 pb-24 pt-4 md:pt-20">
          {children}
        </main>
        <Nav />
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
