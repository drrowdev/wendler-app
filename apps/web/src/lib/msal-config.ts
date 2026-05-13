import { type Configuration, LogLevel, type PopupRequest } from '@azure/msal-browser';

// Personal Microsoft Account only (consumers tenant).
// App registration: "Wendler 5/3/1 PWA" (sign-in audience PersonalMicrosoftAccount).
export const MSAL_CLIENT_ID = '2dbe3445-9d8c-4219-95cf-38ec3058b422';

export const msalConfig: Configuration = {
  auth: {
    clientId: MSAL_CLIENT_ID,
    authority: 'https://login.microsoftonline.com/consumers',
    redirectUri: typeof window !== 'undefined' ? window.location.origin : '/',
    postLogoutRedirectUri: typeof window !== 'undefined' ? window.location.origin : '/',
  },
  cache: {
    cacheLocation: 'localStorage',
    // iOS PWA hardening: keep a cookie copy of the auth state so that when
    // Safari ITP / OS storage reclamation wipes localStorage (typically
    // after ~7 days of PWA inactivity), the cookie can still bridge the
    // redirect callback. MSAL only writes a transient, short-lived nonce
    // here — it's not a substitute for localStorage, just resilience.
    storeAuthStateInCookie: true,
    // Same reason: when localStorage is unavailable mid-flow (Private mode
    // edge cases on iOS), fall back to sessionStorage for in-flight nonces.
    temporaryCacheLocation: 'sessionStorage',
    // Use secure cookies in production; allow non-secure on localhost dev.
    secureCookies: typeof window !== 'undefined' && window.location.protocol === 'https:',
  },
  system: {
    loggerOptions: {
      logLevel: LogLevel.Warning,
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        if (level === LogLevel.Error) console.error(message);
        else if (level === LogLevel.Warning) console.warn(message);
      },
    },
  },
};

// Request just OIDC scopes — the resulting ID token's audience is our clientId,
// which is what the backend validates.
export const loginRequest: PopupRequest = {
  scopes: ['openid', 'profile', 'email'],
};

export const tokenRequest = {
  scopes: ['openid', 'profile', 'email'],
};
