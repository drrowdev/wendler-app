'use client';

// Holds a Screen Wake Lock for the active tab/PWA window when the user
// has opted in via Settings → Keep screen on. Browsers automatically
// release wake locks when the page becomes hidden, so we re-acquire on
// visibilitychange / pageshow / focus events and release on unmount /
// opt-out.
//
// iOS PWA notes:
//   - Wake Lock API was added to Safari in iOS 16.4 and works in
//     standalone PWAs added to the home screen.
//   - In practice, on iOS PWAs Wake Lock acquisition sometimes fails
//     silently — typical causes: doc not yet visible when we try,
//     NotAllowedError requiring a user gesture, system-level Low Power
//     Mode override, etc. The previous version caught all of these and
//     dropped them on the floor, leaving the screen dimming with no
//     diagnostic.
//
// v305 changes:
//   1. Track acquisition state + the last error message in module-scoped
//      vars so a debug indicator can surface them. Settings page reads
//      these to show "active" / "fallback" / "failed: <reason>".
//   2. Retry acquisition on the first user gesture (touch/click) after
//      a failure — Safari historically wants a gesture before granting
//      certain permissions, and a tap inside the PWA satisfies it.
//   3. If Wake Lock fails outright on this device, fall back to a
//      hidden looping silent video — the NoSleep.js trick. Tiny 100B
//      base64 mp4, kept playing forces the screen on.

import { useEffect, useSyncExternalStore } from 'react';
import { useSettings } from '@/lib/hooks';

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
}

// ---------------------------------------------------------------------------
// Diagnostic store — readable via useKeepScreenOnStatus() in settings UI.
// ---------------------------------------------------------------------------

export type KeepScreenOnStatus =
  | { kind: 'off' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'pending' }
  | { kind: 'active'; method: 'wake-lock' | 'video-fallback' }
  | { kind: 'failed'; reason: string; willRetryOnGesture: boolean };

let currentStatus: KeepScreenOnStatus = { kind: 'off' };
const statusListeners = new Set<() => void>();

function setStatus(next: KeepScreenOnStatus): void {
  currentStatus = next;
  for (const fn of statusListeners) fn();
}

export function useKeepScreenOnStatus(): KeepScreenOnStatus {
  return useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb);
      return () => {
        statusListeners.delete(cb);
      };
    },
    () => currentStatus,
    () => currentStatus,
  );
}

// ---------------------------------------------------------------------------
// NoSleep video fallback — a 1-pixel hidden silent looping mp4 keeps the
// screen on when Wake Lock isn't available. From the NoSleep.js project.
// ---------------------------------------------------------------------------

// Tiny seamlessly-looping mp4 (~100B). Source: NoSleep.js (MIT).
const NO_SLEEP_MP4 =
  'data:video/mp4;base64,AAAAGGZ0eXBpc29tAAAAAGlzb21tcDQyAAAACGZyZWUAAAAcbWRhdAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAA==';

function ensureVideoEl(): HTMLVideoElement | null {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById('wendler-nosleep-video') as HTMLVideoElement | null;
  if (el) return el;
  el = document.createElement('video');
  el.id = 'wendler-nosleep-video';
  el.setAttribute('muted', '');
  el.setAttribute('playsinline', '');
  el.setAttribute('loop', '');
  el.muted = true;
  el.playsInline = true;
  el.loop = true;
  el.style.position = 'fixed';
  el.style.bottom = '0';
  el.style.right = '0';
  el.style.width = '1px';
  el.style.height = '1px';
  el.style.opacity = '0.01';
  el.style.pointerEvents = 'none';
  el.style.zIndex = '-1';
  el.src = NO_SLEEP_MP4;
  document.body.appendChild(el);
  return el;
}

async function startVideoFallback(): Promise<boolean> {
  const el = ensureVideoEl();
  if (!el) return false;
  try {
    await el.play();
    return true;
  } catch {
    return false;
  }
}

function stopVideoFallback(): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('wendler-nosleep-video') as HTMLVideoElement | null;
  if (el) {
    el.pause();
    el.remove();
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function KeepScreenOn() {
  const settings = useSettings();
  const enabled = !!settings?.keepScreenOn;

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!enabled) {
      setStatus({ kind: 'off' });
      stopVideoFallback();
      return;
    }
    setStatus({ kind: 'pending' });

    const wl = (navigator as unknown as {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
    }).wakeLock;

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;
    let usingFallback = false;
    let lastError: string | undefined;
    let needsGesture = false;

    const acquire = async (fromGesture = false) => {
      if (cancelled) return;
      if (document.visibilityState !== 'visible') return;

      // Wake Lock path (preferred).
      if (wl?.request) {
        if (sentinel && !sentinel.released) {
          setStatus({ kind: 'active', method: 'wake-lock' });
          return;
        }
        try {
          const next = await wl.request('screen');
          if (cancelled) {
            await next.release().catch(() => {});
            return;
          }
          sentinel = next;
          sentinel.addEventListener('release', () => {
            sentinel = null;
            // Released by the system (typically because visibility changed).
            // The visibility/focus/pageshow handlers will re-acquire when we
            // come back. Don't tear down the fallback machinery here.
          });
          // Stop the fallback video if it was running — Wake Lock is enough.
          if (usingFallback) {
            stopVideoFallback();
            usingFallback = false;
          }
          needsGesture = false;
          setStatus({ kind: 'active', method: 'wake-lock' });
          return;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          // Some browsers throw NotAllowedError without a user gesture.
          // Mark for retry on next interaction.
          needsGesture =
            !fromGesture &&
            /NotAllowedError|denied|gesture|interaction/i.test(lastError);
          // Fall through to the video fallback.
        }
      } else {
        lastError = 'Wake Lock API not available on this device';
      }

      // Video fallback path.
      const ok = await startVideoFallback();
      if (cancelled) {
        stopVideoFallback();
        return;
      }
      if (ok) {
        usingFallback = true;
        setStatus({ kind: 'active', method: 'video-fallback' });
      } else {
        setStatus({
          kind: 'failed',
          reason: lastError ?? 'Both Wake Lock and video fallback failed.',
          willRetryOnGesture: true,
        });
        // Always retry on next gesture as a last resort.
        needsGesture = true;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    const onFocus = () => void acquire();
    const onPageShow = () => void acquire();
    const onGesture = () => {
      if (needsGesture) void acquire(true);
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);
    // Listen on the document for any user gesture; cleaned up below.
    document.addEventListener('touchstart', onGesture, { passive: true });
    document.addEventListener('click', onGesture);
    document.addEventListener('keydown', onGesture);

    void acquire();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('touchstart', onGesture);
      document.removeEventListener('click', onGesture);
      document.removeEventListener('keydown', onGesture);
      if (sentinel && !sentinel.released) {
        sentinel.release().catch(() => {});
      }
      sentinel = null;
      if (usingFallback) {
        stopVideoFallback();
      }
      setStatus({ kind: 'off' });
    };
  }, [enabled]);

  return null;
}
