'use client';

import { useEffect, useRef, useState } from 'react';

interface Props {
  initialSeconds: number;
  /** Called when the timer reaches 0. */
  onDone?: () => void;
  /** Called when the user dismisses the timer manually. */
  onDismiss?: () => void;
  /** Show this label above the countdown. */
  label?: string;
}

/**
 * Floating rest timer pinned above the bottom nav. Counts down using wall-clock time
 * (so backgrounding the tab doesn't drift). Vibrates + fires a Notification when done.
 */
export function RestTimer({ initialSeconds, onDone, onDismiss, label }: Props) {
  const [remaining, setRemaining] = useState(initialSeconds);
  const startedAtRef = useRef<number>(Date.now());
  const targetMsRef = useRef<number>(Date.now() + initialSeconds * 1000);
  const firedRef = useRef(false);

  // Reset when initialSeconds changes (new timer started).
  useEffect(() => {
    startedAtRef.current = Date.now();
    targetMsRef.current = Date.now() + initialSeconds * 1000;
    firedRef.current = false;
    setRemaining(initialSeconds);
  }, [initialSeconds]);

  useEffect(() => {
    const tick = () => {
      const left = Math.max(0, Math.ceil((targetMsRef.current - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0 && !firedRef.current) {
        firedRef.current = true;
        try {
          navigator.vibrate?.([300, 120, 300]);
        } catch {
          // ignore
        }
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification('Rest complete', {
              body: 'Time to lift.',
              tag: 'wendler-rest',
              silent: false,
            });
          }
        } catch {
          // ignore
        }
        onDone?.();
      }
    };
    const id = window.setInterval(tick, 250);
    tick();
    return () => window.clearInterval(id);
  }, [onDone]);

  const add = (delta: number) => {
    targetMsRef.current = Math.max(Date.now(), targetMsRef.current + delta * 1000);
    setRemaining(Math.max(0, Math.ceil((targetMsRef.current - Date.now()) / 1000)));
    firedRef.current = false;
  };

  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, '0');
  const total = Math.max(1, initialSeconds);
  const elapsed = Math.min(total, Math.floor((Date.now() - startedAtRef.current) / 1000));
  const pct = Math.round((elapsed / total) * 100);

  return (
    <div
      className="pointer-events-auto fixed inset-x-0 bottom-16 z-40 mx-auto max-w-3xl px-3 md:bottom-3"
      role="timer"
      aria-live="polite"
    >
      <div
        className={`flex items-center gap-3 rounded-2xl border p-3 shadow-lg backdrop-blur ${
          remaining === 0
            ? 'border-emerald-500/60 bg-emerald-500/20'
            : 'border-accent/60 bg-card/95'
        }`}
      >
        <div className="flex-1">
          <div className="flex items-baseline justify-between">
            <span className="text-xs uppercase tracking-wide text-muted">
              {label ?? 'Rest'}
            </span>
            <span
              className={`font-mono text-2xl font-semibold tabular-nums ${
                remaining === 0 ? 'text-emerald-300' : 'text-fg'
              }`}
            >
              {mm}:{ss}
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded bg-bg">
            <div
              className={`h-full transition-all ${
                remaining === 0 ? 'bg-emerald-500' : 'bg-accent'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <button
          onClick={() => add(-15)}
          className="rounded-lg bg-bg px-2 py-1 text-xs font-semibold ring-1 ring-border"
          aria-label="Subtract 15 seconds"
        >
          −15
        </button>
        <button
          onClick={() => add(15)}
          className="rounded-lg bg-bg px-2 py-1 text-xs font-semibold ring-1 ring-border"
          aria-label="Add 15 seconds"
        >
          +15
        </button>
        <button
          onClick={() => onDismiss?.()}
          className="rounded-lg bg-card px-2 py-1 text-xs ring-1 ring-border"
          aria-label="Dismiss timer"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/**
 * Try to ensure the page can fire local notifications when rest ends.
 * Returns the resulting permission state.
 */
export async function ensureNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}
