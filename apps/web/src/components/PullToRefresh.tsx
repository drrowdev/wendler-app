'use client';

import { useEffect, useRef, useState } from 'react';

const THRESHOLD = 70;
const MAX_PULL = 130;
const RESISTANCE = 0.5;

/**
 * Pull-to-refresh gesture for the standalone PWA. Installed PWAs (iOS/Android
 * standalone mode) suppress the browser's native pull-to-refresh, so the only
 * way to force a fresh fetch was to fully close and reopen the app. This
 * component listens for a top-of-page touch drag, shows a Material-style
 * spinner indicator, and on release past the threshold:
 *   1. asks the SW for an `update()` so a newer worker (and thus newer asset
 *      hashes) can be picked up, then
 *   2. reloads the page (which is network-first for HTML in our SW).
 *
 * Desktop / non-touch is unaffected.
 */
export function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const startX = useRef<number>(0);
  const active = useRef(false);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);

  useEffect(() => {
    pullRef.current = pull;
  }, [pull]);
  useEffect(() => {
    refreshingRef.current = refreshing;
  }, [refreshing]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('ontouchstart' in window)) return;

    function scrollTop() {
      return document.scrollingElement?.scrollTop ?? window.scrollY ?? 0;
    }

    function reset() {
      startY.current = null;
      active.current = false;
      setPull(0);
    }

    function onTouchStart(e: TouchEvent) {
      if (refreshingRef.current) return;
      if (e.touches.length !== 1) {
        startY.current = null;
        return;
      }
      if (scrollTop() > 0) {
        startY.current = null;
        return;
      }
      const t = e.touches[0]!;
      startY.current = t.clientY;
      startX.current = t.clientX;
      active.current = false;
    }

    function onTouchMove(e: TouchEvent) {
      if (refreshingRef.current) return;
      if (startY.current == null) return;
      const t = e.touches[0]!;
      const dy = t.clientY - startY.current;
      const dx = t.clientX - startX.current;

      // Cancel on upward drag, horizontal swipe, or if user has scrolled.
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
        if (active.current) setPull(0);
        active.current = false;
        return;
      }
      if (scrollTop() > 0) {
        if (active.current) setPull(0);
        active.current = false;
        return;
      }

      active.current = true;
      const resisted = Math.min(MAX_PULL, dy * RESISTANCE);
      setPull(resisted);
      // Suppress native overscroll bounce / browser pull-to-refresh while
      // we own the gesture.
      if (e.cancelable) e.preventDefault();
    }

    function onTouchEnd() {
      if (refreshingRef.current) return;
      const wasActive = active.current;
      const finalPull = pullRef.current;
      startY.current = null;
      active.current = false;

      if (wasActive && finalPull >= THRESHOLD) {
        setRefreshing(true);
        setPull(60);
        const reload = () => {
          // Defer slightly so the spinner is visible before reload.
          setTimeout(() => window.location.reload(), 150);
        };
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker
            .getRegistration()
            .then((reg) => (reg ? reg.update() : undefined))
            .catch(() => {})
            .finally(reload);
        } else {
          reload();
        }
      } else {
        setPull(0);
      }
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    // passive: false so we can preventDefault during an active pull.
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove as EventListener);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      reset();
    };
  }, []);

  const visible = pull > 0 || refreshing;
  const ready = !refreshing && pull >= THRESHOLD;
  const rotation = Math.min(360, (pull / THRESHOLD) * 270);
  const translateY = visible ? Math.min(pull, 90) - 8 : -48;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center"
      style={{
        transform: `translateY(${translateY}px)`,
        opacity: visible ? 1 : 0,
        transition:
          refreshing || pull === 0
            ? 'transform 200ms ease, opacity 200ms ease'
            : 'opacity 120ms ease',
        paddingTop: 'env(safe-area-inset-top)',
      }}
    >
      <div
        className={`mt-2 flex h-9 w-9 items-center justify-center rounded-full bg-card/95 shadow-lg ring-1 backdrop-blur ${
          ready ? 'ring-accent/60' : 'ring-border'
        }`}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-accent ${refreshing ? 'animate-spin' : ''}`}
          style={{
            transform: refreshing ? undefined : `rotate(${rotation}deg)`,
            transition: refreshing ? undefined : 'transform 60ms linear',
          }}
        >
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 4v5h-5" />
        </svg>
      </div>
    </div>
  );
}
