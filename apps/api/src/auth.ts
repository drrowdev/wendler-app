import type { HttpRequest } from '@azure/functions';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Personal Microsoft Account ("consumers") tenant.
const JWKS_URI = 'https://login.microsoftonline.com/consumers/discovery/v2.0/keys';
const ISSUER = 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0';

const jwks = jwksClient({
  jwksUri: JWKS_URI,
  cache: true,
  cacheMaxAge: 24 * 60 * 60 * 1000,
  rateLimit: true,
});

function getKey(header: jwt.JwtHeader): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!header.kid) {
      reject(new Error('missing kid'));
      return;
    }
    jwks.getSigningKey(header.kid, (err, key) => {
      if (err || !key) {
        reject(err ?? new Error('no signing key'));
        return;
      }
      resolve(key.getPublicKey());
    });
  });
}

export interface AuthUser {
  userId: string;
  userDetails: string; // email
  name?: string;
  raw: JwtPayload;
}

function getAllowedEmails(): string[] {
  const raw = process.env.OWNER_EMAILS ?? '';
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Verify the Bearer ID token on the request and enforce the OWNER_EMAILS
 * allowlist. Returns the user, or null if the token is missing/invalid/not
 * authorised. Also returns a `reason` for diagnostic logging.
 */
export async function verifyRequest(
  req: HttpRequest,
): Promise<{ user: AuthUser | null; reason?: string }> {
  // SWA strips the Authorization header from client → managed-function calls,
  // so we use a custom header that passes through unchanged.
  const tokenHeader =
    req.headers.get('x-id-token') ?? req.headers.get('X-Id-Token') ?? '';
  const fallback = req.headers.get('authorization') ?? req.headers.get('Authorization') ?? '';
  let token = tokenHeader.trim();
  if (!token && fallback.toLowerCase().startsWith('bearer ')) {
    token = fallback.slice(7).trim();
  }
  if (!token) {
    return { user: null, reason: 'no-token' };
  }

  const clientId = process.env.MSAL_CLIENT_ID;
  if (!clientId) {
    return { user: null, reason: 'server-missing-client-id' };
  }

  let payload: JwtPayload;
  try {
    const decodedHeader = jwt.decode(token, { complete: true });
    if (!decodedHeader || typeof decodedHeader === 'string') {
      return { user: null, reason: 'malformed-token' };
    }
    const key = await getKey(decodedHeader.header);
    payload = jwt.verify(token, key, {
      audience: clientId,
      issuer: ISSUER,
      algorithms: ['RS256'],
    }) as JwtPayload;
  } catch (err) {
    return { user: null, reason: `verify-failed: ${(err as Error).message}` };
  }

  const email =
    (payload.email as string | undefined) ??
    (payload.preferred_username as string | undefined) ??
    '';
  const normalised = email.toLowerCase();

  const allowed = getAllowedEmails();
  if (allowed.length > 0 && !allowed.includes(normalised)) {
    return { user: null, reason: `not-allowed: ${normalised}` };
  }

  const sub = payload.sub;
  if (!sub) return { user: null, reason: 'missing-sub' };

  return {
    user: {
      userId: sub,
      userDetails: email,
      name: payload.name as string | undefined,
      raw: payload,
    },
  };
}

// ---------- HMAC-signed opaque state for OAuth callback flows ----------

function getStateSecret(): string {
  const secret = process.env.AUTH_STATE_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('AUTH_STATE_SECRET not configured (min 16 chars)');
  }
  return secret;
}

/** Sign `userId|timestamp` with HMAC-SHA256; returns base64url. */
export function signState(userId: string): string {
  const payload = `${userId}|${Date.now()}`;
  const sig = createHmac('sha256', getStateSecret()).update(payload).digest('base64url');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

/** Verify a signed state and return the embedded userId, or null if invalid. */
export function verifyState(state: string, maxAgeMs = 10 * 60 * 1000): string | null {
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const parts = decoded.split('|');
    if (parts.length !== 3) return null;
    const [userId, tsStr, sig] = parts as [string, string, string];
    const expected = createHmac('sha256', getStateSecret())
      .update(`${userId}|${tsStr}`)
      .digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const ts = Number(tsStr);
    if (!Number.isFinite(ts) || Date.now() - ts > maxAgeMs) return null;
    return userId;
  } catch {
    return null;
  }
}
