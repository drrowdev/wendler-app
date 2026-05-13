'use client';

import { useEffect, useState } from 'react';
import { subscribeSyncStatus, type SyncStatus } from '@/lib/sync';
import {
  getLocalRetry,
  subscribeLocalSaveState,
  type LocalSaveState,
} from '@/lib/save-status';

// Visible state precedence — local outranks cloud since the user just touched
// the page; cloud sync is a downstream concern. Within each tier we collapse
// transient "saved/synced" pulses into a brief tick that fades to idle.
const SAVED_PULSE_MS = 2000;
const SYNCED_PULSE_MS = 4000;

// Fixed-size icon-only status indicator mounted in the top nav. Always
// renders into the same 28×28 slot so transient "Syncing…" / "Saved" state
// changes never reflow neighbouring nav items. Hover/long-press shows the
// detailed status via the native title tooltip.
export function SaveStatusBadge() {
  const [local, setLocal] = useState<LocalSaveState>({ state: 'idle' });
  const [cloud, setCloud] = useState<SyncStatus>({ state: 'idle' });
  const [, setNow] = useState(() => Date.now());

  useEffect(() => subscribeLocalSaveState(setLocal), []);
  useEffect(() => subscribeSyncStatus(setCloud), []);

  useEffect(() => {
    if (local.state !== 'saved') return;
    const t = setTimeout(() => setNow(Date.now()), SAVED_PULSE_MS + 50);
    return () => clearTimeout(t);
  }, [local]);

  useEffect(() => {
    if (cloud.state !== 'idle' || !cloud.lastChangedAt) return;
    const elapsed = Date.now() - new Date(cloud.lastChangedAt).getTime();
    if (elapsed >= SYNCED_PULSE_MS) return;
    const t = setTimeout(() => setNow(Date.now()), SYNCED_PULSE_MS - elapsed + 50);
    return () => clearTimeout(t);
  }, [cloud]);

  const view = pickView(local, cloud);
  const handleClick = view.kind === 'local-error' ? () => getLocalRetry()?.() : undefined;
  const Tag = handleClick ? 'button' : 'span';

  return (
    <Tag
      type={handleClick ? 'button' : undefined}
      onClick={handleClick}
      title={view.title}
      aria-label={view.label}
      aria-live="polite"
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${view.className}`}
    >
      {view.icon}
    </Tag>
  );
}

type Kind =
  | 'local-saving'
  | 'local-saved'
  | 'local-error'
  | 'cloud-syncing'
  | 'cloud-error'
  | 'cloud-synced'
  | 'cloud-offline'
  | 'idle';

interface BadgeView {
  kind: Kind;
  icon: React.ReactNode;
  label: string;
  title: string;
  className: string;
}

function pickView(local: LocalSaveState, cloud: SyncStatus): BadgeView {
  // Tier 1 — local state is most relevant to the user's last action.
  if (local.state === 'error') {
    return {
      kind: 'local-error',
      icon: <CrossIcon />,
      label: 'Save failed',
      title: `Save failed: ${local.message}. Click to retry.`,
      className: 'text-red-300 hover:text-red-200',
    };
  }
  if (local.state === 'saving') {
    return {
      kind: 'local-saving',
      icon: <SpinnerIcon />,
      label: 'Saving',
      title: 'Saving change to this device…',
      className: 'text-muted',
    };
  }
  const savedRecently =
    local.state === 'saved' && Date.now() - local.at < SAVED_PULSE_MS;

  // Tier 2 — cloud state.
  if (cloud.state === 'syncing') {
    return {
      kind: 'cloud-syncing',
      icon: <SpinnerIcon />,
      label: 'Syncing',
      title: 'Syncing with the cloud…',
      className: 'text-muted',
    };
  }
  if (cloud.state === 'error') {
    return {
      kind: 'cloud-error',
      icon: <CrossIcon />,
      label: 'Sync failed',
      title: `Sync failed: ${cloud.message ?? 'unknown error'}`,
      className: 'text-amber-300',
    };
  }
  if (savedRecently) {
    return {
      kind: 'local-saved',
      icon: <CheckIcon />,
      label: 'Saved',
      title: 'Saved to this device',
      className: 'text-emerald-300',
    };
  }
  if (cloud.state === 'idle' && cloud.lastChangedAt) {
    const ts = new Date(cloud.lastChangedAt);
    const elapsed = Date.now() - ts.getTime();
    if (elapsed < SYNCED_PULSE_MS) {
      return {
        kind: 'cloud-synced',
        icon: <CheckIcon />,
        label: 'Synced',
        title: `Last synced ${ts.toLocaleTimeString()}`,
        className: 'text-emerald-300',
      };
    }
    return {
      kind: 'idle',
      icon: <CheckIcon />,
      label: 'Up to date',
      title: `Last synced ${ts.toLocaleTimeString()}`,
      className: 'text-muted/70',
    };
  }
  if (cloud.state === 'unauthenticated') {
    return {
      kind: 'cloud-offline',
      icon: <CloudOffIcon />,
      label: 'Local only',
      title: 'Not signed in — changes stay on this device',
      className: 'text-muted/70',
    };
  }
  // True idle with no prior sync — show a quiet check so the slot is filled.
  return {
    kind: 'idle',
    icon: <CheckIcon />,
    label: 'Up to date',
    title: 'No pending changes',
    className: 'text-muted/70',
  };
}

const ICON_PROPS = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.25,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function CheckIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function CloudOffIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3 3l18 18" />
      <path d="M17.5 17.5H6.5a3.5 3.5 0 01-.4-6.97" />
      <path d="M9.5 5.5A5.5 5.5 0 0119 9.5a3.5 3.5 0 012.4 5.6" />
    </svg>
  );
}

// Two-arrow circular refresh icon, continuously rotating. Kept fixed size.
function SpinnerIcon() {
  return (
    <svg {...ICON_PROPS} className="animate-spin">
      <path d="M21 12a9 9 0 11-3.2-6.9" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}
