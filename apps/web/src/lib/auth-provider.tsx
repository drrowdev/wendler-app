'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  PublicClientApplication,
  EventType,
  InteractionRequiredAuthError,
  BrowserAuthError,
  type AccountInfo,
  type AuthenticationResult,
} from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import { msalConfig, loginRequest } from './msal-config';

let pca: PublicClientApplication | null = null;

function getMsal(): PublicClientApplication {
  if (!pca) {
    pca = new PublicClientApplication(msalConfig);
  }
  return pca;
}

/**
 * Wraps the app in MsalProvider and handles redirect callbacks.
 * Lazily initialises the PublicClientApplication on the client only.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const instance = useMemo(() => getMsal(), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await instance.initialize();
      try {
        const result = await instance.handleRedirectPromise();
        if (result?.account) {
          instance.setActiveAccount(result.account);
        } else {
          const accounts = instance.getAllAccounts();
          if (accounts.length > 0) {
            instance.setActiveAccount(accounts[0]!);
          }
        }
      } catch (err) {
        console.error('MSAL redirect handling failed', err);
      }
      const cb = instance.addEventCallback((event) => {
        if (
          event.eventType === EventType.LOGIN_SUCCESS ||
          event.eventType === EventType.ACQUIRE_TOKEN_SUCCESS
        ) {
          const result = event.payload as AuthenticationResult;
          if (result?.account) instance.setActiveAccount(result.account);
        }
      });
      if (!cancelled) setReady(true);
      return () => {
        if (cb) instance.removeEventCallback(cb);
      };
    })();
    return () => {
      cancelled = true;
    };
  }, [instance]);

  if (!ready) {
    // Block render until MSAL is initialised; avoids flashing the sign-in screen
    // when the user already has a cached session.
    return null;
  }

  return <MsalProvider instance={instance}>{children}</MsalProvider>;
}

export function getActiveAccount(): AccountInfo | null {
  if (!pca) return null;
  return pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? null;
}

// Throttle interactive recovery so a flurry of 401s in parallel triggers at
// most ONE redirect — otherwise multiple in-flight authFetch calls each kick
// off a redirect and the user sees a rapid sequence of MS sign-in screens.
let interactionInFlight = false;

/**
 * Trigger an interactive token redirect to recover from a stale / missing
 * session. Idempotent within a single page lifetime — if a redirect was
 * already started, subsequent calls are no-ops.
 *
 * The redirect navigates the page to login.microsoftonline.com; when MS
 * recognises the existing session (usually instant on iOS if the user is
 * already signed in to MS in Safari), it bounces back to this app with a
 * fresh token. From the user's seat: one quick redirect, no manual sign-in.
 */
function triggerInteractiveRecovery(): void {
  if (interactionInFlight) return;
  interactionInFlight = true;
  const instance = getMsal();
  const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0];
  // Log to the notifications inbox BEFORE the redirect so the entry is in
  // place when the user returns. Lazy-import to avoid pulling Dexie into
  // the auth-provider module graph at startup.
  void (async () => {
    try {
      const { notify } = await import('./notify');
      await notify.info({
        channel: 'auth',
        title: 'Re-authenticating with Microsoft',
        body: account?.username
          ? `Silent token refresh failed; redirecting to Microsoft to renew the session for ${account.username}. This is the iOS PWA's usual recovery path.`
          : 'Silent token refresh failed; redirecting to Microsoft to renew the session.',
        context: { account: account?.username },
      });
    } catch {
      // Swallow — notification logging must never block auth recovery.
    }
  })();
  // acquireTokenRedirect with loginHint = account.username keeps the user
  // on the same MS account when multiple are signed in to the browser.
  void instance.acquireTokenRedirect({
    ...loginRequest,
    ...(account?.username ? { loginHint: account.username } : {}),
    account: account ?? undefined,
  });
}

/**
 * Acquire a fresh ID token for the active account.
 *
 * iOS PWA caveat: `acquireTokenSilent` relies on a hidden iframe to
 * login.microsoftonline.com. Safari ITP blocks the third-party cookies that
 * iframe needs, so the silent path frequently throws
 * `InteractionRequiredAuthError`. When that happens we IMMEDIATELY trigger
 * an interactive redirect instead of silently returning null — the previous
 * behavior left the API request unauthenticated and forced the user to
 * manually sign out + in to recover.
 *
 * The redirect is throttled (see `triggerInteractiveRecovery`) so multiple
 * concurrent 401s don't fire multiple redirects.
 */
export async function acquireIdToken(): Promise<string | null> {
  const instance = getMsal();
  const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0];
  if (!account) return null;
  try {
    const result = await instance.acquireTokenSilent({
      scopes: ['openid', 'profile', 'email'],
      account,
    });
    return result.idToken ?? null;
  } catch (err) {
    // The two MSAL errors that mean "ask the user to sign in again":
    //  - InteractionRequiredAuthError → expected when the cached refresh
    //    artifact is gone (ITP wiped it, 7-day storage purge, etc.)
    //  - BrowserAuthError with errorCode 'monitor_window_timeout' or
    //    'silent_sso_error' → the silent iframe was blocked by Safari
    if (
      err instanceof InteractionRequiredAuthError ||
      err instanceof BrowserAuthError
    ) {
      console.warn(
        'MSAL silent acquire failed, triggering interactive recovery',
        err,
      );
      triggerInteractiveRecovery();
      return null;
    }
    console.warn('acquireTokenSilent failed (non-interaction)', err);
    return null;
  }
}

/**
 * Called by `authFetch` when the API returns 401 with a valid-looking token
 * attached. Either the server clock skewed past our token's `exp` claim, the
 * server-side allowlist rejected us, or the token was minted for a different
 * audience. In all cases the recovery is the same as for silent-acquire
 * failure: bounce through MS for a fresh interactive sign-in.
 */
export function handleUnauthorizedResponse(): void {
  triggerInteractiveRecovery();
}
