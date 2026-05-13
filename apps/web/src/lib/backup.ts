'use client';

/**
 * Web-side wrapper around `@wendler/domain/backup`. Adds the Dexie I/O the
 * pure helpers can't depend on. All format/validation/migration logic lives
 * in the domain package and is unit-tested there.
 */

import {
  BACKUP_TABLES,
  buildBackupFile,
  redactRow,
  sortRowsById,
  stableStringify,
  summarise,
  type BackupData,
  type BackupFile,
  type BackupSummary,
  type BackupTable,
} from '@wendler/domain';
import { SCHEMA_VERSION } from '@wendler/db-schema';
import type Dexie from 'dexie';
import type { Table } from 'dexie';
import { getDb } from './db';

export { BACKUP_TABLES };
export type { BackupTable, BackupFile, BackupSummary, BackupData };

export interface ExportOptions {
  /** Replace free-text notes/descriptions with [redacted]. */
  redactNotes?: boolean;
}

export interface ExportResult {
  file: BackupFile;
  summary: BackupSummary;
  /** Pretty-printed, deterministic JSON for download. */
  json: string;
  suggestedFilename: string;
}

function tableOf(db: Dexie, name: BackupTable): Table<unknown, unknown> {
  return (db as unknown as Record<string, Table<unknown, unknown>>)[name]!;
}

export async function exportBackup(
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const db = getDb();
  const data = {} as BackupData;
  for (const name of BACKUP_TABLES) {
    const t = tableOf(db, name);
    const raw = await t.toArray();
    const sorted = sortRowsById(raw);
    data[name] = opts.redactNotes ? sorted.map(redactRow) : sorted;
  }
  const file = buildBackupFile({
    schemaVersion: SCHEMA_VERSION,
    data,
    redacted: opts.redactNotes ?? false,
  });
  const json = stableStringify(file, 2);
  const datePart = file.exportedAt.slice(0, 10);
  return {
    file,
    summary: summarise(data),
    json,
    suggestedFilename: `wendler-backup-${datePart}.json`,
  };
}

/** Trigger a browser download of a backup blob. */
export function downloadBackup(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Render the backup JSON inside an already-opened window so the user can
 * select-all / copy-paste it. Pass a window reference that was opened
 * synchronously in the click handler (otherwise popup blockers will eat it).
 * Returns true on success, false if the window isn't usable.
 */
export function renderBackupInWindow(
  win: Window | null,
  json: string,
  filename: string,
): boolean {
  if (!win || win.closed) return false;
  try {
    const escaped = json
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const safeName = filename.replace(/[<>&"']/g, '');
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeName}</title>
  <style>
    :root { color-scheme: light dark; }
    html, body { margin: 0; padding: 0; height: 100%; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    header { display: flex; gap: .5rem; align-items: center; padding: .75rem 1rem; border-bottom: 1px solid #4443; position: sticky; top: 0; background: Canvas; }
    header h1 { font-size: 1rem; margin: 0; flex: 1; font-weight: 600; }
    button { font: inherit; padding: .4rem .9rem; border-radius: .4rem; border: 1px solid #8888; background: #8881; cursor: pointer; }
    button:hover { background: #8883; }
    main { padding: 1rem; }
    textarea { width: 100%; height: calc(100vh - 110px); box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre; padding: .75rem; border: 1px solid #8884; border-radius: .4rem; background: Canvas; color: CanvasText; }
    .hint { font-size: .8rem; opacity: .7; margin-right: .5rem; }
  </style>
</head>
<body>
  <header>
    <h1>${safeName}</h1>
    <span class="hint" id="hint"></span>
    <button id="copy" type="button">Copy all</button>
    <button id="select" type="button">Select all</button>
    <button id="download" type="button">Download</button>
  </header>
  <main>
    <textarea id="json" readonly spellcheck="false">${escaped}</textarea>
  </main>
  <script>
    (function () {
      var ta = document.getElementById('json');
      var hint = document.getElementById('hint');
      var json = ta.value;
      function flash(msg) {
        hint.textContent = msg;
        setTimeout(function () { hint.textContent = ''; }, 2000);
      }
      document.getElementById('select').addEventListener('click', function () {
        ta.focus();
        ta.select();
      });
      document.getElementById('copy').addEventListener('click', function () {
        ta.focus();
        ta.select();
        var ok = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(json).then(
              function () { flash('Copied ✓'); },
              function () {
                ok = document.execCommand && document.execCommand('copy');
                flash(ok ? 'Copied ✓' : 'Copy failed — use Ctrl/Cmd+C');
              }
            );
            return;
          }
          ok = document.execCommand && document.execCommand('copy');
          flash(ok ? 'Copied ✓' : 'Copy failed — use Ctrl/Cmd+C');
        } catch (e) {
          flash('Copy failed — use Ctrl/Cmd+C');
        }
      });
      document.getElementById('download').addEventListener('click', function () {
        try {
          var blob = new Blob([json], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = ${JSON.stringify(filename)};
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 0);
        } catch (e) {
          flash('Download failed — use Copy instead');
        }
      });
    })();
  </script>
</body>
</html>`;
    win.document.open();
    win.document.write(html);
    win.document.close();
    return true;
  } catch {
    return false;
  }
}
