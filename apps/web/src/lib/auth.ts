'use client';

import { useEffect, useState } from 'react';

export interface AuthState {
  loaded: boolean;
  authenticated: boolean;
  userId?: string;
  userDetails?: string;
  identityProvider?: string;
}

const LOGIN_URL = '/.auth/login/aad?post_login_redirect_uri=/';
const LOGOUT_URL = '/.auth/logout?post_logout_redirect_uri=/';

export function loginUrl(): string {
  return LOGIN_URL;
}

export function logoutUrl(): string {
  return LOGOUT_URL;
}

/**
 * Reactive hook around /.auth/me (SWA built-in). Polls once on mount and
 * exposes a refresh function for callers (e.g. after the user clicks Sign in).
 */
export function useAuth(): AuthState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<AuthState>({ loaded: false, authenticated: false });

  async function refresh() {
    try {
      const res = await fetch('/api/me', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) {
        setState({ loaded: true, authenticated: false });
        return;
      }
      const data = await res.json();
      if (data.authenticated) {
        setState({
          loaded: true,
          authenticated: true,
          userId: data.userId,
          userDetails: data.userDetails,
          identityProvider: data.identityProvider,
        });
      } else {
        setState({ loaded: true, authenticated: false });
      }
    } catch {
      setState({ loaded: true, authenticated: false });
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return { ...state, refresh };
}
