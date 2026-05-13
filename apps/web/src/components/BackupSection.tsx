'use client';

import { useRef, useState } from 'react';
import {
  exportBackup,
  renderBackupInWindow,
  type BackupSummary,
  type ExportResult,
} from '@/lib/backup';
import {
  importBackup,
  readBackupFile,
  BackupImportError,
  type ImportMode,
  type ImportResult,
} from '@/lib/backupImport';

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; verb: string }
  | { kind: 'exported'; result: ExportResult; popupBlocked: boolean }
  | { kind: 'imported'; result: ImportResult }
  | { kind: 'error'; message: string };

export function BackupSection() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [redact, setRedact] = useState(false);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const onExport = async () => {
    // Open the popup synchronously inside the click handler so popup blockers
    // don't kill it. We'll fill it once the export resolves.
    const win =
      typeof window !== 'undefined' ? window.open('', '_blank') : null;
    if (win) {
      try {
        win.document.open();
        win.document.write(
          '<!doctype html><title>Preparing backup…</title><body style="font-family:system-ui;padding:1rem">Preparing backup…</body>',
        );
        win.document.close();
      } catch {
        /* ignore */
      }
    }
    setStatus({ kind: 'busy', verb: 'Exporting…' });
    try {
      const result = await exportBackup({ redactNotes: redact });
      const opened = renderBackupInWindow(
        win,
        result.json,
        result.suggestedFilename,
      );
      setStatus({ kind: 'exported', result, popupBlocked: !opened });
    } catch (e) {
      try {
        win?.close();
      } catch {
        /* ignore */
      }
      setStatus({ kind: 'error', message: (e as Error).message });
    }
  };

  const onPickFile = () => fileInput.current?.click();

  const onFileChosen = async (file: File) => {
    if (mode === 'replace' && !confirmReplace) {
      setStatus({
        kind: 'error',
        message:
          'Replace will wipe all local data first. Tick the confirmation box if you mean it.',
      });
      return;
    }
    setStatus({ kind: 'busy', verb: 'Importing…' });
    try {
      const raw = await readBackupFile(file);
      const result = await importBackup(raw, { mode });
      setStatus({ kind: 'imported', result });
      setConfirmReplace(false);
    } catch (e) {
      const msg =
        e instanceof BackupImportError
          ? e.message
          : `Import failed: ${(e as Error).message}`;
      setStatus({ kind: 'error', message: msg });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
        Backup &amp; restore
      </h2>
      <p className="mb-3 text-xs text-muted">
        Export every block, session, race, goal, training-max, and setting as a
        single JSON file you can keep offline. Import on another device to
        restore.
      </p>

      <div className="space-y-4">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Export</h3>
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={redact}
              onChange={(e) => setRedact(e.target.checked)}
              className="accent-accent"
            />
            Redact training notes (replace with “[redacted]”)
          </label>
          <p className="text-xs text-muted">
            ⚠️ Without redaction the JSON contains all your training notes.
            Treat it like any other personal export.
          </p>
          <button
            type="button"
            onClick={onExport}
            disabled={status.kind === 'busy'}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg disabled:opacity-50"
          >
            Open backup in new tab
          </button>
          <p className="text-xs text-muted">
            Opens the JSON in a new tab so you can copy-paste or save it
            yourself. Allow pop-ups for this site if nothing happens.
          </p>
        </div>

        <div className="space-y-2 border-t border-border pt-3">
          <h3 className="text-sm font-medium">Import</h3>
          <fieldset className="space-y-1 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="import-mode"
                value="merge"
                checked={mode === 'merge'}
                onChange={() => {
                  setMode('merge');
                  setConfirmReplace(false);
                }}
                className="accent-accent"
              />
              <span>
                <strong>Merge</strong> — keep local rows that are newer; only
                pull in newer or missing rows from the backup.
              </span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="import-mode"
                value="replace"
                checked={mode === 'replace'}
                onChange={() => setMode('replace')}
                className="accent-accent"
              />
              <span>
                <strong>Replace</strong> — wipe local data first, then load the
                backup verbatim.
              </span>
            </label>
          </fieldset>
          {mode === 'replace' && (
            <label className="flex items-center gap-2 text-xs text-red-300">
              <input
                type="checkbox"
                checked={confirmReplace}
                onChange={(e) => setConfirmReplace(e.target.checked)}
                className="accent-red-400"
              />
              I understand this wipes every local block, session, race, goal,
              setting, and movement override before loading the file.
            </label>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFileChosen(f);
            }}
          />
          <button
            type="button"
            onClick={onPickFile}
            disabled={status.kind === 'busy'}
            className="rounded-lg bg-card px-4 py-2 text-sm font-semibold ring-1 ring-border disabled:opacity-50"
          >
            Choose backup file…
          </button>
        </div>

        <StatusPane status={status} />
      </div>
    </section>
  );
}

function StatusPane({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'busy') {
    return <p className="text-sm text-muted">{status.verb}</p>;
  }
  if (status.kind === 'error') {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
        {status.message}
      </div>
    );
  }
  if (status.kind === 'exported') {
    return (
      <div className="space-y-2">
        <SummaryPane
          title={
            status.popupBlocked
              ? `Prepared ${status.result.suggestedFilename} (popup blocked)`
              : `Opened ${status.result.suggestedFilename} in a new tab`
          }
          summary={status.result.summary}
        />
        {status.popupBlocked && (
          <InlineExportFallback
            json={status.result.json}
            filename={status.result.suggestedFilename}
          />
        )}
      </div>
    );
  }
  return (
    <SummaryPane
      title={`${status.result.mode === 'replace' ? 'Replaced' : 'Merged'} — wrote ${status.result.written} rows`}
      summary={status.result.summary}
      conflicts={status.result.conflicts.length}
    />
  );
}

function SummaryPane({
  title,
  summary,
  conflicts,
}: {
  title: string;
  summary: BackupSummary;
  conflicts?: number;
}) {
  const rows = Object.entries(summary.counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-1 rounded-lg border border-accent/40 bg-accent/10 p-3 text-sm">
      <div className="font-medium">{title}</div>
      <div className="text-xs text-muted">
        {summary.total} rows total
        {typeof conflicts === 'number' && conflicts > 0
          ? ` · ${conflicts} skipped (local newer or untimestamped)`
          : ''}
      </div>
      <ul className="mt-1 grid grid-cols-2 gap-x-3 text-xs text-muted">
        {rows.map(([table, n]) => (
          <li key={table}>
            {table}: <span className="text-fg">{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InlineExportFallback({
  json,
  filename,
}: {
  json: string;
  filename: string;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const flash = (msg: string) => {
    setCopied(msg);
    setTimeout(() => setCopied(null), 2000);
  };
  const onSelect = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.select();
  };
  const onCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(json);
        flash('Copied ✓');
        return;
      }
    } catch {
      /* fall through */
    }
    onSelect();
    try {
      const ok = document.execCommand('copy');
      flash(ok ? 'Copied ✓' : 'Press Ctrl/Cmd+C');
    } catch {
      flash('Press Ctrl/Cmd+C');
    }
  };
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-muted">
          {filename} — popup blocked, copy from here instead.
        </span>
        {copied && <span className="text-xs text-accent">{copied}</span>}
        <button
          type="button"
          onClick={onCopy}
          className="rounded-md bg-accent px-2 py-1 text-xs font-semibold text-bg"
        >
          Copy all
        </button>
        <button
          type="button"
          onClick={onSelect}
          className="rounded-md bg-card px-2 py-1 text-xs font-semibold ring-1 ring-border"
        >
          Select all
        </button>
      </div>
      <textarea
        ref={taRef}
        readOnly
        spellCheck={false}
        value={json}
        className="h-64 w-full rounded-md border border-border bg-bg p-2 font-mono text-xs"
      />
    </div>
  );
}
