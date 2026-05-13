'use client';

import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { type ReactNode } from 'react';
import { loginRequest } from '@/lib/msal-config';

export function AuthGuard({ children }: { children: ReactNode }) {
  const isAuthenticated = useIsAuthenticated();
  const { instance, inProgress } = useMsal();

  if (isAuthenticated) {
    return <>{children}</>;
  }

  const signIn = () => {
    void instance.loginRedirect(loginRequest);
  };

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 px-6 text-center">
      <div>
        <h1 className="text-2xl font-bold text-fg">Wendler 5/3/1</h1>
        <p className="mt-2 text-sm text-muted">
          Sign in with your Microsoft account to access the app.
        </p>
      </div>
      <button
        type="button"
        onClick={signIn}
        disabled={inProgress !== 'none'}
        className="rounded-lg border border-border bg-card px-5 py-2.5 text-sm font-medium text-fg hover:bg-border disabled:opacity-60"
      >
        {inProgress !== 'none' ? 'Signing in…' : 'Sign in with Microsoft'}
      </button>
      <p className="max-w-sm text-xs text-muted">
        Access is restricted to the owner. If you&apos;re not the owner, sign-in will be rejected.
      </p>
    </div>
  );
}
