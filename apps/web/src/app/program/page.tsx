'use client';

import Link from 'next/link';

export default function ProgramIndex() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Program</h1>
        <p className="text-sm text-muted">
          v0.1: set Training Maxes for the four main lifts. Block scheduling (Leader/Anchor) and
          supplemental templates land in v0.2.
        </p>
      </header>
      <Link
        href="/program/setup"
        className="inline-block rounded-lg bg-accent px-4 py-2 font-semibold text-bg"
      >
        Edit Training Maxes
      </Link>
    </div>
  );
}
