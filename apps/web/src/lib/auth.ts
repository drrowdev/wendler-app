'use client';

import { useAccount, useIsAuthenticated, useMsal } from '@azure/msal-react';
import { useCallback } from 'react';
import { acquireIdToken, handleUnauthorizedResponse } from './auth-provider';
import { loginRequest } from './msal-config';

export interface AuthState {
  loaded: boolean;
  authenticated: boolean;
  userId?: string;
  userDetails?: string;
  identityProvider?: string;
}

/**
 * Hook around MSAL state that mirrors the previous SWA-style shape so
 * existing components (AuthBadge etc.) keep working.
 */
export function useAuth(): AuthState & {
  refresh: () => Promise<void>;
  signIn: () => void;
  signOut: () => void;
} {
  const isAuthenticated = useIsAuthenticated();
  const { instance, inProgress } = useMsal();
  const account = useAccount(instance.getActiveAccount() ?? instance.getAllAccounts()[0] ?? {});

  const signIn = useCallback(() => {
    void instance.loginRedirect(loginRequest);
  }, [instance]);

  const signOut = useCallback(() => {
    void instance.logoutRedirect({ postLogoutRedirectUri: window.location.origin });
  }, [instance]);

  const refresh = useCallback(async () => {
    // MSAL caches state itself; nothing to refetch.
  }, []);

  return {
    loaded: inProgress === 'none',
    authenticated: isAuthenticated,
    userId: account?.localAccountId ?? account?.homeAccountId,
    userDetails: account?.username,
    identityProvider: 'msa',
    refresh,
    signIn,
    signOut,
  };
}

/** Add `X-Id-Token: <id_token>` to a fetch RequestInit. */
export async function withAuth(init: RequestInit = {}): Promise<RequestInit> {
  const token = await acquireIdToken();
  const headers = new Headers(init.headers ?? {});
  if (token) headers.set('X-Id-Token', token);
  return { ...init, headers };
}

/** Convenience fetch that automatically attaches the bearer token.
 *
 * On 401, triggers an interactive token redirect via MSAL so the user
 * doesn't have to manually sign out + in. The fetch returns the original
 * 401 response — the caller may have already navigated away by the time
 * the redirect resolves, but `handleUnauthorizedResponse` is throttled so
 * concurrent 401s don't trigger multiple redirects.
 */
export async function authFetch(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
  const withTok = await withAuth(init);
  const res = await fetch(input, withTok);
  if (res.status === 401) {
    handleUnauthorizedResponse();
  }
  return res;
}
