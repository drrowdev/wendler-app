'use client';

// Backwards-compatible redirect stub. /recovery is now a tab within /load —
// see app/load/page.tsx. The Azure SWA config also rewrites /recovery →
// /load?tab=recovery for fresh HTTP visits; this client component handles
// in-PWA client-side navigation to the legacy path.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function RecoveryRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/load?tab=recovery');
  }, [router]);
  return (
    <div className="space-y-2 p-4 text-sm text-muted">
      <p>Recovery moved to Load &amp; recovery → Recovery tab.</p>
      <p>
        <a href="/load?tab=recovery" className="text-accent underline">
          Open it
        </a>
      </p>
    </div>
  );
}
