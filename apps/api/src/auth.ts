import type { HttpRequest } from '@azure/functions';

export interface ClientPrincipal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
  claims?: { typ: string; val: string }[];
}

/**
 * Decode the SWA-injected x-ms-client-principal header.
 * Returns null when the request is unauthenticated.
 */
export function getClientPrincipal(req: HttpRequest): ClientPrincipal | null {
  const header = req.headers.get('x-ms-client-principal');
  if (!header) return null;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const principal = JSON.parse(decoded) as ClientPrincipal;
    if (!principal.userId) return null;
    return principal;
  } catch {
    return null;
  }
}
