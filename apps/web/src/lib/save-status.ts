'use client';

// Singleton tracker for the most recent local-save activity, plus a retry
// hook for the last failed write. Pages with auto-save behavior call
// `beginLocalSave` / `endLocalSave` (or the convenience `trackLocalSave`
// helper) and the global `<SaveStatusBadge />` in the top nav reflects the
// state regardless of where in the app the edit happened.
//
// The state machine is intentionally tiny — a single in-flight counter and
// a single most-recent error/success — because every write becomes the
// "current" save from the user's POV, and a top-nav badge can only show
// one status at a time.

export type LocalSaveState =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved'; at: number }
  | { state: 'error'; message: string };

let current: LocalSaveState = { state: 'idle' };
let inflight = 0;
let retry: (() => void) | null = null;
const listeners = new Set<(s: LocalSaveState) => void>();

function emit() {
  for (const fn of listeners) fn(current);
}

export function subscribeLocalSaveState(fn: (s: LocalSaveState) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}

export function getLocalRetry(): (() => void) | null {
  return retry;
}

export function setLocalRetry(fn: (() => void) | null): void {
  retry = fn;
}

export function beginLocalSave(): void {
  inflight += 1;
  current = { state: 'saving' };
  emit();
}

export function endLocalSaveOk(): void {
  inflight = Math.max(0, inflight - 1);
  retry = null;
  if (inflight === 0) {
    current = { state: 'saved', at: Date.now() };
    emit();
  }
}

export function endLocalSaveErr(message: string, retryFn?: () => void): void {
  inflight = Math.max(0, inflight - 1);
  retry = retryFn ?? null;
  current = { state: 'error', message };
  emit();
}

/**
 * Convenience wrapper. Surrounds an async write with begin/end calls so
 * call sites just do `await trackLocalSave(() => db.foo.update(...))`. On
 * failure the supplied `retry` (defaults to re-running the same op) is
 * stored so the badge can offer one-tap recovery.
 */
export async function trackLocalSave<T>(
  op: () => Promise<T>,
  retryFn?: () => void,
): Promise<T> {
  beginLocalSave();
  try {
    const result = await op();
    endLocalSaveOk();
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    endLocalSaveErr(message, retryFn ?? (() => void trackLocalSave(op, retryFn)));
    throw err;
  }
}
