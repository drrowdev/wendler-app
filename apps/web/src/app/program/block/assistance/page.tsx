'use client';

// Legacy deep-link target. Per-day assistance editing is now inline on the
// block detail page. We redirect /program/block/assistance?id=X&day=N to
// /program/block?id=X#day-N so existing bookmarks and links continue to work.

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function AssistanceRedirectWrapper() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <AssistanceRedirect />
    </Suspense>
  );
}

function AssistanceRedirect() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const id = params.get('id') ?? '';
    const day = params.get('day') ?? '0';
    const target = id ? `/program/block?id=${id}#day-${day}` : '/program';
    router.replace(target);
  }, [router, params]);

  return <p className="text-muted">Redirecting to block editor…</p>;
}
